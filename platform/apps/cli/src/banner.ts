// ASCII banner with professional gradient colours for the `adlc` CLI and terminal output.
import { PLATFORM_VERSION } from './version.js';

export const BANNER_LINES: readonly string[] = [
  '    ___                    __  _        _____ ____  __    ______',
  '   /   | ____ ____  ____  / /_(_)____  / ___// __ \\/ /   / ____/',
  '  / /| |/ __ `/ _ \\/ __ \\/ __/ / ___/  \\__ \\/ / / / /   / /     ',
  ' / ___ / /_/ /  __/ / / / /_/ / /__   ___/ / /_/ / /___/ /___   ',
  '/_/  |_\\__, /\\___/_/ /_/\\__/_/\\___/  /____/_____/_____/\\____/   ',
  '      /____/                                                    ',
];

export const SUBTITLE_TAGLINE =
  'Autonomous AI Agents • 8 Quality Gates • Cryptographic Audit Trail';

/** Sky Blue to Indigo gradient palette for an enterprise tech aesthetic. */
const GRADIENT_COLORS: readonly string[] = [
  '\x1b[38;2;56;189;248m', // Sky Blue 400
  '\x1b[38;2;14;165;233m', // Sky Blue 500
  '\x1b[38;2;2;132;199m', // Sky Blue 600
  '\x1b[38;2;37;99;235m', // Royal Blue 600
  '\x1b[38;2;79;70;229m', // Electric Indigo 600
  '\x1b[38;2;99;102;241m', // Indigo 500
];

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  cyanAccent: '\x1b[38;2;56;189;248m',
  dotAccent: '\x1b[38;2;14;165;233m',
} as const;

export interface BannerOptions {
  /** If false, disables ANSI color escapes. Defaults to environment check. */
  readonly color?: boolean;
  /** Custom version override. Defaults to PLATFORM_VERSION. */
  readonly version?: string;
}

/** Determines whether ANSI color codes should be suppressed. */
export function shouldDisableColor(env?: Readonly<Record<string, string | undefined>>): boolean {
  if (!env) return false;
  return env.NO_COLOR !== undefined || env.TERM === 'dumb';
}

/**
 * Renders the ASCII banner.
 * Uses 24-bit truecolor gradient if color is enabled, or plain text if disabled.
 */
export function renderBanner(
  env?: Readonly<Record<string, string | undefined>>,
  options?: BannerOptions,
): string {
  const version = options?.version ?? PLATFORM_VERSION;
  const useColor = options?.color ?? !shouldDisableColor(env);

  if (!useColor) {
    const plainLines = [
      ...BANNER_LINES,
      '',
      `  Agentic SDLC Framework (v${version})`,
      `  ${SUBTITLE_TAGLINE}`,
    ];
    return plainLines.join('\n');
  }

  const coloredArt = BANNER_LINES.map((line, idx) => {
    const color = GRADIENT_COLORS[idx] ?? GRADIENT_COLORS[GRADIENT_COLORS.length - 1];
    return `${color}${ANSI.bold}${line}${ANSI.reset}`;
  }).join('\n');

  const titleLine = `  ${ANSI.cyanAccent}◈${ANSI.reset} ${ANSI.bold}${ANSI.white}Agentic SDLC Framework${ANSI.reset} ${ANSI.dim}${ANSI.gray}(v${version})${ANSI.reset}`;
  const subtitleLine = `  ${ANSI.dim}${ANSI.gray}Autonomous AI Agents ${ANSI.dotAccent}•${ANSI.reset}${ANSI.dim}${ANSI.gray} 8 Quality Gates ${ANSI.dotAccent}•${ANSI.reset}${ANSI.dim}${ANSI.gray} Cryptographic Audit Trail${ANSI.reset}`;

  return `${coloredArt}\n\n${titleLine}\n${subtitleLine}`;
}
