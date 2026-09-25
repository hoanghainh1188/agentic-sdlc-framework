#!/bin/sh
# One-shot job: create or upgrade the Temporal schemas in PostgreSQL (task A02).
# Temporal no longer ships the "auto-setup" image after 1.29, so this job uses
# temporal-sql-tool from the admin-tools image. Safe to re-run: setup-schema
# is skipped when the schema exists, and update-schema is idempotent.
set -eu

SCHEMA_DIR=/etc/temporal/schema/postgresql/v12
export SQL_PLUGIN=postgres12 SQL_HOST=postgres SQL_PORT=5432
export SQL_USER=temporal SQL_PASSWORD="$TEMPORAL_DB_PASSWORD"

for pair in "temporal:temporal" "temporal_visibility:visibility"; do
  db="${pair%%:*}"
  dir="${pair##*:}"
  echo "temporal-schema: database $db"
  # --quiet: an existing schema is not an error. Connection errors still fail below.
  temporal-sql-tool --quiet --db "$db" setup-schema -v 0.0
  temporal-sql-tool --db "$db" update-schema -d "$SCHEMA_DIR/$dir/versioned"
done
echo "temporal-schema: done"
