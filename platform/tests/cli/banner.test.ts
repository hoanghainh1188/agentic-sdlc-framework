// Tests for the CLI ASCII banner and color rendering.
import { describe, expect, it } from 'vitest';

import { BANNER_LINES, renderBanner, shouldDisableColor } from '../../apps/cli/src/banner.js';
import { EXIT, runCli, type CliContext } from '../../apps/cli/src/index.js';
import { PLATFORM_VERSION } from '../../apps/cli/src/version.js';

const hasColour = (text: string): boolean => text.includes('\u001b') || text.includes('\u009b');

function makeContext(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: () => {
      throw new Error('no database in tests');
    },
  };
  return { ctx, out, err };
}

describe('CLI ASCII banner', () => {
  it('renders all ASCII art lines and version tag', () => {
    const banner = renderBanner({}, { color: false });
    for (const line of BANNER_LINES) {
      expect(banner).toContain(line);
    }
    expect(banner).toContain(`v${PLATFORM_VERSION}`);
    expect(banner).toContain('Autonomous AI Agents');
    expect(banner).toContain('8 Quality Gates');
    expect(hasColour(banner)).toBe(false);
  });

  it('disables color when NO_COLOR is defined or TERM=dumb', () => {
    expect(shouldDisableColor({ NO_COLOR: '' })).toBe(true);
    expect(shouldDisableColor({ NO_COLOR: '1' })).toBe(true);
    expect(shouldDisableColor({ TERM: 'dumb' })).toBe(true);
    expect(shouldDisableColor({})).toBe(false);

    const bannerNoColor = renderBanner({ NO_COLOR: '1' });
    expect(hasColour(bannerNoColor)).toBe(false);

    const bannerDumb = renderBanner({ TERM: 'dumb' });
    expect(hasColour(bannerDumb)).toBe(false);
  });

  it('renders rich gradient colors when color is enabled', () => {
    const banner = renderBanner({}, { color: true });
    expect(hasColour(banner)).toBe(true);
    // Truecolor escape sequences
    expect(banner).toContain('\x1b[38;2;');
    expect(banner).toContain('\x1b[0m');
  });

  it('adlc banner prints the banner and exits 0', async () => {
    const { ctx, out } = makeContext({ NO_COLOR: '1' });
    expect(await runCli(['banner'], ctx)).toBe(EXIT.ok);
    expect(out.length).toBe(1);
    expect(out[0]).toContain(BANNER_LINES[0]);
    expect(out[0]).toContain(`v${PLATFORM_VERSION}`);
  });

  it('adlc --banner prints the banner and exits 0', async () => {
    const { ctx, out } = makeContext({ NO_COLOR: '1' });
    expect(await runCli(['--banner'], ctx)).toBe(EXIT.ok);
    expect(out.length).toBe(1);
    expect(out[0]).toContain(BANNER_LINES[0]);
    expect(out[0]).toContain(`v${PLATFORM_VERSION}`);
  });
});
