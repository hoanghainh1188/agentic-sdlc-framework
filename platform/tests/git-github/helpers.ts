// Shared setup of the GitHub adapter tests.
import { GitHubAdapter, type GitHubAdapterOptions } from '@sdlc/adapter-git-github';
import type { GitHostLogEvent } from '@sdlc/contracts';

import { FakeSecrets, StubGitHub } from './stub-github';

export interface Harness {
  readonly stub: StubGitHub;
  readonly secrets: FakeSecrets;
  readonly logs: { level: string; event: GitHostLogEvent; fields: Record<string, unknown> }[];
  readonly sleeps: number[];
  adapter(extra?: Partial<GitHubAdapterOptions>): GitHubAdapter;
}

export async function startHarness(): Promise<Harness> {
  const stub = new StubGitHub();
  await stub.start();
  const secrets = new FakeSecrets();
  const logs: Harness['logs'] = [];
  const sleeps: number[] = [];
  return {
    stub,
    secrets,
    logs,
    sleeps,
    adapter: (extra = {}) =>
      new GitHubAdapter({
        secrets,
        apiUrl: stub.address,
        allowPlaintext: true,
        now: () => stub.now,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        logger: {
          log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }),
        },
        ...extra,
      }),
  };
}
