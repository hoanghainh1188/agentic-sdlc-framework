// Structured JSON log lines of the worker (task B06). One logger serves the poller, the GitHub
// adapter and the OpenBao client: their events are codes and their fields hold IDs, codes, counts
// and times only, never comment text, tokens or keys. Task A08 replaces this with the platform
// logger (OpenTelemetry).
export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface WorkerLogger {
  log(level: LogLevel, event: string, fields: LogFields): void;
}

export function jsonLogger(
  write: (line: string) => void,
  now: () => Date = () => new Date(),
): WorkerLogger {
  return {
    log(level, event, fields) {
      write(`${JSON.stringify({ time: now().toISOString(), level, event, ...fields })}\n`);
    },
  };
}
