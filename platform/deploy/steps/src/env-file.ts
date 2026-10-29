// Reading and changing the deployment's env file (README "Fresh deployment" step 2, written by
// `init-env.sh`). Pure: the caller reads and writes the file.

/** One value of an env file, or undefined. */
export function envValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  return m?.[1];
}

/** The text with `key` set to `value`: the line replaced, or appended when there is none. */
export function setEnvValue(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  return `${text.endsWith('\n') || text === '' ? text : `${text}\n`}${key}=${value}\n`;
}

/** Keys of the env file whose values are secrets (passwords, keys, tokens, salts). */
const SECRET_KEY = /(PASSWORD|SECRET|_KEY|TOKEN|SALT)$/;

/** The secret values of an env file, to hide them in any output (review V02 #4). */
export function envSecrets(text: string): string[] {
  return [...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)]
    .filter(([, key, value]) => SECRET_KEY.test(key ?? '') && (value ?? '').length >= 8)
    .map(([, , value]) => value ?? '');
}

/** The host port of a service in the env file (`SDLC_API_HOST_PORT` …), or its default. */
export function hostPort(text: string, key: string, fallback: number): number {
  const value = Number(envValue(text, key));
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** The PostgreSQL URL of one role from the host, built from the env file (README step 6, 8). */
export function databaseUrl(text: string, role: 'platform' | 'platform_app'): string {
  const key = role === 'platform' ? 'PLATFORM_DB_PASSWORD' : 'PLATFORM_APP_DB_PASSWORD';
  const password = envValue(text, key) ?? '';
  if (password === '') throw new Error(`${key} is missing in the env file`);
  const port = hostPort(text, 'POSTGRES_HOST_PORT', 5432);
  return `postgres://${role}:${encodeURIComponent(password)}@127.0.0.1:${port}/platform`;
}
