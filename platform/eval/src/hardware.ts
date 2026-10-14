// Where an evaluation ran and on what hardware (task L04, design/ADR-M81 §2.1, AC1). The same task
// set and configuration give comparable numbers on a developer machine and on the server only if
// the reader can see the machine behind them. Codes and numbers only: a CPU model is a short name.
import os from 'node:os';

export type ExecutionPlace = 'developer' | 'server';

export interface HardwareInfo {
  /** For example `Apple M4 Pro`; letters, digits and a few signs, at most 128 characters. */
  readonly cpu_model: string;
  readonly cpu_cores: number;
  /** Total memory in whole gigabytes (rounded down). */
  readonly memory_gb: number;
  readonly docker_version: string;
  /** The GPU name, or null when none is known. */
  readonly gpu: string | null;
  /** The runner's instance label on the server; null on a developer machine. */
  readonly runner_instance: string | null;
}

export const HARDWARE_FIELDS = [
  'cpu_model',
  'cpu_cores',
  'memory_gb',
  'docker_version',
  'gpu',
  'runner_instance',
] as const;

const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._:@()/+-]{0,127}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const INSTANCE = /^[a-z][a-z0-9_.:-]{0,63}$/;

/** Keeps a machine name inside the allowed characters (never free text from a command). */
export function cleanName(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 ._:@()/+-]/g, '')
    .trim()
    .slice(0, 128);
}

export const isPlace = (value: unknown): value is ExecutionPlace =>
  value === 'developer' || value === 'server';

/** Checks a hardware block: exactly the declared fields, each in its format. Throws otherwise. */
export function checkHardware(value: unknown): HardwareInfo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hardware: not an object');
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(
    (key) => !(HARDWARE_FIELDS as readonly string[]).includes(key),
  );
  if (extra.length > 0) throw new TypeError(`hardware: undeclared field ${extra.join(', ')}`);
  const count = (key: string): boolean =>
    typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0;
  const text = (key: string, pattern: RegExp, nullable: boolean): boolean => {
    const v = record[key];
    return v === null ? nullable : typeof v === 'string' && pattern.test(v);
  };
  const checks: [string, boolean][] = [
    ['cpu_model', text('cpu_model', MODEL, false)],
    ['cpu_cores', count('cpu_cores')],
    ['memory_gb', count('memory_gb')],
    ['docker_version', text('docker_version', VERSION, false)],
    ['gpu', text('gpu', MODEL, true)],
    ['runner_instance', text('runner_instance', INSTANCE, true)],
  ];
  for (const [field, ok] of checks) if (!ok) throw new TypeError(`hardware: bad field ${field}`);
  return record as unknown as HardwareInfo;
}

/** The hardware of this process's machine; the caller adds the Docker version and the GPU. */
export function describeHardware(input: {
  readonly dockerVersion: string;
  readonly gpu?: string | null;
  readonly runnerInstance?: string | null;
}): HardwareInfo {
  const cpus = os.cpus();
  return checkHardware({
    cpu_model: cleanName(cpus[0]?.model ?? '') || 'unknown',
    cpu_cores: cpus.length,
    memory_gb: Math.floor(os.totalmem() / 1024 ** 3),
    docker_version: cleanName(input.dockerVersion) || 'unknown',
    gpu: input.gpu ? cleanName(input.gpu) || null : null,
    runner_instance: input.runnerInstance ?? null,
  });
}

/** A short label for the report: `Apple M4 Pro, 12 cores, 24 GB`. */
export function hardwareLabel(hardware: HardwareInfo): string {
  return `${hardware.cpu_model}, ${String(hardware.cpu_cores)} cores, ${String(hardware.memory_gb)} GB`;
}
