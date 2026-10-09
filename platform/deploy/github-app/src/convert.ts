// Exchanging the manifest code for the new App (D-08 V03): POST /app-manifests/{code}/conversions,
// no authentication, within one hour. GitHub answers with the App's ID, client ID, slug, private
// key, client secret and webhook secret. Only the first four are kept: the client secret and the
// webhook secret are dropped at once, never stored, printed or logged (QUESTIONS #351; the
// platform uses neither: no OAuth, no webhook).

/** What the platform keeps from the new App. `pem` is the private key: only written to its file. */
export interface AppCredentials {
  readonly id: number;
  readonly clientId: string;
  readonly slug: string;
  readonly pem: string;
}

export type ConversionErrorCode = 'unreachable' | 'refused' | 'bad_response';

/** Carries a code and the HTTP status only, never GitHub's text (it may hold a secret). */
export class ConversionError extends Error {
  constructor(
    readonly code: ConversionErrorCode,
    readonly status?: number,
  ) {
    super(code);
  }
}

const PEM =
  /^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END (?:RSA )?PRIVATE KEY-----\n?$/;

/** Picks the four kept fields out of GitHub's answer; refuses an answer that does not fit. */
export function keepCredentials(body: unknown): AppCredentials {
  if (typeof body !== 'object' || body === null) throw new ConversionError('bad_response');
  const { id, client_id: clientId, slug, pem } = body as Record<string, unknown>;
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof clientId !== 'string' ||
    !/^[A-Za-z0-9.]{1,64}$/.test(clientId) ||
    typeof slug !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug) ||
    typeof pem !== 'string' ||
    !PEM.test(pem.replaceAll('\r\n', '\n'))
  )
    throw new ConversionError('bad_response');
  return { id, clientId, slug, pem: pem.replaceAll('\r\n', '\n') };
}

export async function convertManifestCode(
  apiUrl: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppCredentials> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'agentic-sdlc-framework-github-app-create',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ConversionError('unreachable');
  }
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new ConversionError('refused', response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConversionError('bad_response');
  }
  return keepCredentials(body);
}
