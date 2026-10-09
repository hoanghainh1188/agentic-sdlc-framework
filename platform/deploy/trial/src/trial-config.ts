// The project configuration of the trial (design/M-E-TRIAL-PLAN.md §6; README step 12): only the
// settings that differ from the platform defaults. Pure.

/** The agent `trial:up` registers (README step 11). */
export const TRIAL_AGENT_KEY = 'trial-coder';
export const TRIAL_AGENT_VERSION = '1.0.0';

export function trialProjectConfig(sandboxImage: string): string {
  if (!/@sha256:[0-9a-f]{64}$/.test(sandboxImage)) {
    throw new Error('the sandbox image must be pinned by digest');
  }
  return [
    '# The trial M-E (design/M-E-TRIAL-PLAN.md §6), written by pnpm trial:up.',
    'oversight:',
    '  hotl_block_window: { value: 1, unit: working_hours }',
    'verification:',
    '  required_checks: [ci-ok]',
    'run:',
    `  agent_key: ${TRIAL_AGENT_KEY}`,
    'sandbox:',
    `  image: ${sandboxImage}`,
    '',
  ].join('\n');
}
