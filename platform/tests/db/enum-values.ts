// The values of a PostgreSQL enum after all migrations, read from their SQL: `CREATE TYPE … AS
// ENUM (…)`, then every `ALTER TYPE … ADD VALUE 'v' [BEFORE | AFTER 'w']` in migration order
// (C06 adds G4 reason codes before `other`, migration 0011).
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';

export function enumValuesAfterMigrations(name: string): string[] {
  const statements = Object.values(MIGRATIONS).flatMap((m) => m.statements.up);
  let values: string[] | undefined;
  for (const statement of statements) {
    const created = new RegExp(`CREATE TYPE ${name} AS ENUM\\s*\\(([^)]*)\\)`).exec(statement);
    if (created) values = [...created[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    const added = new RegExp(
      `ALTER TYPE ${name} ADD VALUE '([^']+)'(?:\\s+(BEFORE|AFTER)\\s+'([^']+)')?`,
    ).exec(statement);
    if (added && values) {
      const [, value, where, other] = added;
      const at = other === undefined ? values.length : values.indexOf(other);
      values.splice(where === 'AFTER' ? at + 1 : at, 0, value!);
    }
  }
  if (!values) throw new Error(`enum ${name} not found`);
  return values;
}
