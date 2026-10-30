// `pnpm alerts` (O03, design/ADR-M101, rule R144): it runs doctor's checks and adds no command of
// its own except the server's `sendmail`; it is never a service of the compose file (the schedule
// is the server's); it reads only `SDLC_ALERT_*` keys of the env file.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const dir = path.join(root, 'platform/deploy/alerts/src');
const sources = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));

describe('pnpm alerts adds no command and no schedule (R144)', () => {
  it('the only process it starts is sendmail, in channels.ts', () => {
    const starts = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/g)].map(
        (m) => `${file}:${m[1]}`,
      ),
    );
    expect(starts).toEqual(['channels.ts:spawn']);
    expect(sources.find((s) => s.file === 'channels.ts')!.text).toContain(
      "spawn(settings.sendmail, ['-t', '-oi']",
    );
  });

  it("doctor's commands come only through doctor's own allowlist (createExec)", () => {
    const main = sources.find((s) => s.file === 'main.ts')!.text;
    expect(main).toContain("from '../../doctor/dist/exec.js'");
    expect(main).toContain('createExec(');
  });

  it('no compose file runs it: the schedule is the server timer', () => {
    for (const f of fs.readdirSync(path.join(root, 'platform/deploy'))) {
      if (!/^docker-compose.*\.ya?ml$/.test(f)) continue;
      expect(fs.readFileSync(path.join(root, 'platform/deploy', f), 'utf8'), f).not.toMatch(
        /alerts/,
      );
    }
    const timer = fs.readFileSync(
      path.join(root, 'platform/deploy/alerts/sdlc-alerts.timer'),
      'utf8',
    );
    expect(timer).toMatch(/OnUnitActiveSec=10min/);
  });

  it('it reads the env file only through allowedValues with ALERT_KEYS', () => {
    const run = sources.find((s) => s.file === 'run.ts')!.text;
    expect(run).toMatch(/allowedValues\(fs\.readFileSync\(deps\.envFile, 'utf8'\), ALERT_KEYS\)/);
    expect(
      sources.filter((s) => /readFileSync\([^)]*envFile/.test(s.text)).map((s) => s.file),
    ).toEqual(['run.ts']);
  });
});
