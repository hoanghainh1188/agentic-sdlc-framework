// `pnpm openbao:bootstrap rotate-credentials` (O05, design/ADR-M102), run for real against a stub
// `docker`: the admin token is read once and reused by every credentials command; it only ever
// travels on stdin; an AppRole with no secret ID is skipped; any other answer of the list stops
// the pass, so "renewed" is never claimed for nothing. The token here is a fake test value.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deployDir } from './compose';

const BOOTSTRAP = path.join(deployDir, 'openbao/bootstrap.sh');
const TOKEN = 'fake-admin-token-for-the-stub';

// The stub answers the calls bootstrap.sh makes, by what the call contains, and logs every call:
// its arguments on one line, its standard input on lines starting with "IN".
const STUB = `#!/bin/sh
args="$*"
input="$(cat)"
printf 'ARGS %s\\n' "$args" >>"$STUB_DIR/calls.log"
printf '%s\\n' "$input" | sed 's/^/IN /' >>"$STUB_DIR/calls.log"
last="\${args##* }"
case "$args" in
  *seal-status*) echo '{"initialized":true,"sealed":false}' ;;
  *"token lookup"*) exit "\${STUB_LOOKUP_RC:-0}" ;;
  *"config --images"*) echo stub-image:1 ;;
  *"secret-id-accessor/destroy"*) ;;
  *secret_id_accessor*) printf 'role-id\\nsecret-id\\n0123abcd-0000-4000-8000-000000000000\\n' ;;
  *'2>&1)"'*) eval "echo \\\${STUB_STATE_$last:-some}" ;;
  *" run --rm "*) printf '%s\\n' "$input" | tail -n 1 ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function rotate(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-stub-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'docker'), STUB, { mode: 0o755 });
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    'COMPOSE_PROJECT_NAME=rotstub\nPLATFORM_APP_DB_PASSWORD=stub-db-password\n',
    {
      mode: 0o600,
    },
  );
  const r = spawnSync('sh', [BOOTSTRAP, 'rotate-credentials'], {
    input: `${TOKEN}\n`,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      SDLC_ENV_FILE: envFile,
      STUB_DIR: dir,
      ...env,
    },
  });
  const log = fs.existsSync(path.join(dir, 'calls.log'))
    ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8')
    : '';
  return { status: r.status, out: `${r.stdout}${r.stderr}`, log };
}

describe('rotate-credentials against a stub docker (O05)', () => {
  it('renews every AppRole that has a secret ID, with the one token given once', () => {
    const r = rotate();
    expect(r.out).toContain('secret IDs renewed: api worker runner litellm backup');
    expect(r.status).toBe(0);
    // The token is on stdin only, never an argument; the output never shows it.
    const args = r.log.split('\n').filter((l) => l.startsWith('ARGS '));
    expect(args.some((l) => l.includes(TOKEN))).toBe(false);
    expect(r.log).toContain(`IN ${TOKEN}`);
    expect(r.out).not.toContain(TOKEN);
  });

  it('skips an AppRole with no secret ID yet and says so', () => {
    const r = rotate({ STUB_STATE_litellm: 'none', STUB_STATE_backup: 'none' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('litellm: no secret ID yet');
    expect(r.out).toContain('backup: no secret ID yet');
    expect(r.out).toContain('secret IDs renewed: api worker runner;');
  });

  it('a list it cannot read (a token without the right) stops the pass and names what was renewed', () => {
    const r = rotate({ STUB_STATE_runner: 'error' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('could not list the secret IDs of the AppRole runner');
    expect(r.out).toContain('renewed so far: api worker');
    expect(r.out).not.toContain('secret IDs renewed');
  });

  it('nothing set up: a failure, never "renewed"', () => {
    const none = Object.fromEntries(
      ['api', 'worker', 'runner', 'litellm', 'backup'].map((r) => [`STUB_STATE_${r}`, 'none']),
    );
    const r = rotate(none);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('nothing was renewed');
  });

  it('a token that is not valid stops before any list or delivery', () => {
    const r = rotate({ STUB_LOOKUP_RC: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the token is not valid');
    expect(r.log).not.toContain('2>&1)"');
    expect(r.log).not.toContain(' run --rm ');
  });
});
