// The local page and the callback (D-08 V03): an HTTP server on 127.0.0.1 only, on a random port.
// The page has no script: one form whose button posts the manifest to GitHub. GitHub sends the
// browser back to /callback with a one-time `code` and our `state`. One valid callback, then the
// server closes.
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { t } from '@sdlc/messages';

/** A manifest code from GitHub: short, URL-safe. Anything else is refused before it is used. */
export const isManifestCode = (code: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(code);

/** Compares two strings in constant time (for equal lengths); unequal lengths never match. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const escapeHtml = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // No script, no style, nothing from elsewhere; the form may post to GitHub only.
  'Content-Security-Policy':
    "default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

/** The form page: the manifest as a hidden field, one button. */
export function formPage(action: string, manifestJson: string): string {
  return page(
    t('github_app.page.title'),
    `<p>${escapeHtml(t('github_app.page.intro'))}</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
<button type="submit">${escapeHtml(t('github_app.page.button'))}</button>
</form>`,
  );
}

export interface CallbackServer {
  /** The local page to open in the browser. */
  readonly url: string;
  readonly redirectUrl: string;
  /** The code of the first callback with the right state. */
  readonly code: Promise<string>;
  close(): Promise<void>;
}

export interface ServerOptions {
  readonly state: string;
  /** Builds the form page once the port is known (the redirect URL names it). */
  readonly formPage: (redirectUrl: string) => string;
}

/** Starts the server on 127.0.0.1 and a random port. */
export async function startCallbackServer(options: ServerOptions): Promise<CallbackServer> {
  let resolveCode!: (code: string) => void;
  const code = new Promise<string>((resolve) => (resolveCode = resolve));
  let done = false;
  let host = '';
  let form = '';

  const server = http.createServer((req, res) => {
    const send = (status: number, html: string, then?: () => void): void => {
      res.writeHead(status, { ...HEADERS, Connection: 'close' });
      res.end(html, then);
    };
    // Only this server's own address: a page elsewhere that points a name at 127.0.0.1 (DNS
    // rebinding) never reads the form or sends a callback.
    if (req.headers.host !== host || req.method !== 'GET') {
      send(404, page(t('github_app.page.not_found'), ''));
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      send(400, page(t('github_app.page.not_found'), ''));
      return;
    }
    if (url.pathname === '/' && !done) {
      send(200, form);
      return;
    }
    if (url.pathname === '/callback' && !done) {
      const state = url.searchParams.get('state') ?? '';
      const value = url.searchParams.get('code') ?? '';
      if (!sameSecret(state, options.state) || !isManifestCode(value)) {
        send(400, page(t('github_app.page.refused'), ''));
        return;
      }
      done = true;
      // The code is handed over once the page is sent, so closing the server never cuts it off.
      send(200, page(t('github_app.page.done'), ''), () => resolveCode(value));
      return;
    }
    send(404, page(t('github_app.page.not_found'), ''));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  const redirectUrl = `http://${host}/callback`;
  form = options.formPage(redirectUrl);

  return {
    url: `http://${host}/`,
    redirectUrl,
    code,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The fallback when the browser could not reach 127.0.0.1 (QUESTIONS #350): the person pastes the
 * whole address from the browser, or the code alone. A pasted address must carry our state.
 */
export function codeFromPaste(input: string, state: string): string | undefined {
  const text = input.trim();
  // The state itself looks like a code: a mistaken paste of it is refused, never sent to GitHub.
  if (isManifestCode(text)) return sameSecret(text, state) ? undefined : text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const value = url.searchParams.get('code') ?? '';
  if (!sameSecret(url.searchParams.get('state') ?? '', state)) return undefined;
  return isManifestCode(value) ? value : undefined;
}
