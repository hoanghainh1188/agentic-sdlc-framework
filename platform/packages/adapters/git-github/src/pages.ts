// Paginated GitHub lists (`Link: rel="next"`), with a page limit.
import type { GitHubHttp, RequestInput } from './http.js';
import { arr } from './json.js';

export interface PageOptions {
  readonly auth: string;
  readonly query?: RequestInput['query'];
  readonly maxPages: number;
  /** Items of one page: the body itself (default) or a field of it. */
  readonly extract?: (body: unknown) => readonly unknown[];
  /** Stops before this item (lists sorted newest first). */
  readonly stopAt?: (item: unknown) => boolean;
  readonly cache?: boolean;
}

export interface PageResult {
  readonly items: readonly unknown[];
  /** True when the page limit ended the list before its end. */
  readonly truncated: boolean;
}

export async function listPages(
  http: GitHubHttp,
  path: string,
  options: PageOptions,
): Promise<PageResult> {
  const extract = options.extract ?? ((body: unknown) => arr(body, 'list'));
  const items: unknown[] = [];
  let target: string | URL = http.url(path, { per_page: 100, ...options.query });
  for (let page = 0; page < options.maxPages; page += 1) {
    const res = await http.json('GET', target, {
      auth: options.auth,
      cache: options.cache ?? true,
    });
    for (const item of extract(res.body)) {
      if (options.stopAt?.(item)) return { items, truncated: false };
      items.push(item);
    }
    if (!res.next) return { items, truncated: false };
    target = new URL(res.next);
  }
  return { items, truncated: true };
}
