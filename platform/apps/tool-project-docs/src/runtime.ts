// The run's settings and credential of the tool (task X04 PR 3b): the two files the runner wrote
// into the tool's runtime volume. Checked before use; a file that does not match stops the tool,
// and the runner then sees no healthy container (`tool_unavailable`).
import type { ToolRuntimeConfig, ToolRuntimeCredentials } from '@sdlc/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCHEMA = /^kdocs_p[0-9a-f]{32}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const HOST = /^[a-z][a-z0-9-]{0,62}$/;
const GATEWAY_URL = /^http:\/\/[a-z][a-z0-9-]{0,62}:[0-9]{1,5}$/;

/** Why the files were refused (no value is ever echoed). */
export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';

  constructor(readonly field: string) {
    super(`tool.runtime_invalid: ${field}`);
  }
}

function object(text: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RuntimeError(field);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError(field);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new RuntimeError(field);
  return value;
}

function secret(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 4096) {
    throw new RuntimeError(field);
  }
  return value;
}

export function readRuntime(
  configText: string,
  credentialsText: string,
): { config: ToolRuntimeConfig; credentials: ToolRuntimeCredentials } {
  const c = object(configText, 'config');
  if (c.schema_version !== 1) throw new RuntimeError('schema_version');
  const db = (c.database ?? {}) as Record<string, unknown>;
  const port = db.port;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new RuntimeError('database.port');
  }
  const config: ToolRuntimeConfig = {
    schema_version: 1,
    index_id: text(c.index_id, UUID, 'index_id'),
    schema: text(c.schema, SCHEMA, 'schema'),
    model: text(c.model, MODEL, 'model'),
    database: {
      host: text(db.host, HOST, 'database.host'),
      port: port as number,
      name: text(db.name, HOST, 'database.name'),
    },
    model_gateway_url: text(c.model_gateway_url, GATEWAY_URL, 'model_gateway_url'),
  };
  const k = object(credentialsText, 'credentials');
  const credentials: ToolRuntimeCredentials = {
    db_username: secret(k.db_username, 'db_username'),
    db_password: secret(k.db_password, 'db_password'),
    llm_key: secret(k.llm_key, 'llm_key'),
  };
  return { config, credentials };
}
