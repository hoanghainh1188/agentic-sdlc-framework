// An in-memory default branch for the spec tests of B08 (ADR-M39): each change is a new head
// commit; `down` makes every call fail like an unavailable Git host.
import { GitHostError, type GitHostAdapter } from '../../packages/contracts/src/index.js';

export const SPEC_PATH = 'docs/specs/T07.md';
export const SPEC_TEXT = '# T07 Cancel an order\nAC1: stock returns.\n';

/** A repository on the default branch: each change is a new head commit. */
export class FakeSpecGitHost implements Pick<GitHostAdapter, 'getBranchHead' | 'getFileAtCommit'> {
  head = '';
  down = false;
  headReads = 0;
  private readonly commits = new Map<string, Map<string, string>>();
  private count = 0;

  constructor() {
    this.commit({ [SPEC_PATH]: SPEC_TEXT });
  }

  /** A new head commit: `text` sets a file, null removes it. */
  commit(changes: Readonly<Record<string, string | null>>): string {
    const files = new Map(this.commits.get(this.head) ?? []);
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, text);
    }
    this.count += 1;
    this.head = this.count.toString(16).padStart(40, '0');
    this.commits.set(this.head, files);
    return this.head;
  }

  getBranchHead(): Promise<string> {
    this.headReads += 1;
    if (this.down) return Promise.reject(new GitHostError('server_error', { status: 502 }));
    return Promise.resolve(this.head);
  }

  getFileAtCommit(_ref: unknown, path: string, sha: string): Promise<string> {
    if (this.down) return Promise.reject(new GitHostError('server_error', { status: 502 }));
    const text = this.commits.get(sha)?.get(path);
    return text === undefined
      ? Promise.reject(new GitHostError('not_found'))
      : Promise.resolve(text);
  }
}
