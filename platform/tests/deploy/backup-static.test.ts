// D-08 task A10 PR 2 (design/ADR-M63 §5, QUESTIONS #326–#329): static checks of the backup scripts
// and the backup job. The live drill is platform/tests/integration/backup/backup.test.ts.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deployDir, loadCompose, readDeployFile } from './compose';

const SCRIPTS = ['backup/backup.sh', 'backup/restore.sh', 'backup/snapshot.sh'];
const compose = loadCompose();

describe('backup scripts (A10)', () => {
  it.each(SCRIPTS)('%s is valid POSIX sh and executable', (file) => {
    const full = path.join(deployDir, file);
    expect(spawnSync('sh', ['-n', full]).status).toBe(0);
    expect(fs.statSync(full).mode & 0o111).not.toBe(0);
  });

  it('backup.sh writes every part through age; only the MANIFEST is plain', () => {
    const code = readDeployFile('backup/backup.sh')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'));
    const writes = code.filter((line) => /"\$partial\/[^"]*"/.test(line) && /(>|-o )/.test(line));
    expect(writes.length).toBeGreaterThan(0);
    for (const line of writes) expect(line, line).toMatch(/age -R|\/MANIFEST"/);
    expect(code.join('\n')).toMatch(/pg_dumpall -U postgres --clean --if-exists/);
  });

  it('restore.sh checks the MANIFEST first and restores only into an empty stack', () => {
    const code = readDeployFile('backup/restore.sh');
    expect(code.indexOf('SHA-256 differs from MANIFEST')).toBeLessThan(
      code.indexOf('decrypt env.tar'),
    );
    expect(code).toMatch(/restore only into an empty stack/);
    expect(code).toMatch(/operator raft snapshot restore -force/);
    expect(code).not.toMatch(/echo .*\$(temp_key|temp_token)/);
  });

  it('the backup job reads only the snapshot, hardened, and never starts with up.sh', () => {
    const job = compose.services['backup-agent']!;
    expect(job.profiles).toEqual(['backup']);
    expect(job.restart).toBe('no');
    expect(job.ports).toBeUndefined();
    const s = job as { read_only?: boolean; cap_drop?: string[]; user?: string };
    expect(s.read_only).toBe(true);
    expect(s.cap_drop).toEqual(['ALL']);
    expect(s.user).toBe('100:1000');
    expect(job.volumes).toEqual([
      './backup/snapshot.sh:/openbao/backup/snapshot.sh:ro',
      'backup-approle:/openbao/approle',
      'openbao-ca:/openbao/ca:ro',
    ]);
    expect(readDeployFile('openbao/bootstrap/policies/backup.hcl')).toMatch(
      /path "sys\/storage\/raft\/snapshot" \{\s*capabilities = \["read"\]\s*\}/,
    );
  });

  it('the systemd example runs pnpm backup daily', () => {
    expect(readDeployFile('backup/sdlc-backup.service')).toMatch(
      /ExecStart=\/bin\/sh platform\/deploy\/backup\/backup\.sh/,
    );
    expect(readDeployFile('backup/sdlc-backup.timer')).toMatch(/OnCalendar=\*-\*-\* 02:30:00/);
  });
});
