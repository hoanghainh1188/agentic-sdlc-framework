// C07 (QUESTIONS #126, ADR-M34 §2.4): the paths OpenHands 1.48.0 reads as instructions, folded.
import { isAgentInstructionPath, unpinnedInstructionPaths } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

describe('isAgentInstructionPath', () => {
  it.each([
    'AGENTS.md',
    'agents.md',
    'Agents.MD',
    'agent.md',
    'CLAUDE.md',
    'claude.md',
    'GEMINI.md',
    '.cursorrules',
    '.CursorRules',
    'apps/api/AGENTS.md',
    'deep/a/b/agents.md',
    '.agents/skills/deploy.md',
    '.agents/skills/sub/SKILL.md',
    '.openhands/skills/x.md',
    '.OpenHands/Microagents/repo.md',
    'AGENTS\u200B.md',
    './AGENTS.md',
  ])('%j is an instruction file', (path) => {
    expect(isAgentInstructionPath(path)).toBe(true);
  });

  it.each([
    'README.md',
    'docs/CLAUDE.md',
    'apps/agent.md',
    'src/.cursorrules',
    'docs/GEMINI.md',
    '.agents/README.md',
    '.openhands/setup.sh',
    'x/.openhands/skills/a.md',
    'AGENTS.md.bak',
    '',
  ])('%j is not an instruction file', (path) => {
    expect(isAgentInstructionPath(path)).toBe(false);
  });
});

describe('unpinnedInstructionPaths (G4)', () => {
  it('leaves out the pinned file only, by its exact path', () => {
    expect(
      unpinnedInstructionPaths(
        ['AGENTS.md', 'agents.md', 'src/main.ts', 'apps/api/AGENTS.md', 'README.md'],
        'AGENTS.md',
      ),
    ).toEqual(['agents.md', 'apps/api/AGENTS.md']);
  });

  it('is empty for a repository with only the pinned file', () => {
    expect(unpinnedInstructionPaths(['AGENTS.md', 'src/a.ts'], 'AGENTS.md')).toEqual([]);
  });
});
