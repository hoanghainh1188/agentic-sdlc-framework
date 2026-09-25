#!/bin/sh
# Creates the application role of the platform database (task A06, design/ADR-M09 section 2.3).
# The platform processes connect as platform_app. It owns nothing: the migrations (run as the
# owner, platform) grant it SELECT, INSERT and UPDATE on chosen columns; never DELETE or DDL.
#
# Runs once on an empty data volume (docker-entrypoint-initdb.d). Idempotent, so an operator can
# also run it on an existing volume (platform/deploy/README.md, "Platform database roles").
# The password comes from the environment and is passed to psql as a variable.
set -eu

: "${PLATFORM_APP_DB_PASSWORD:?PLATFORM_APP_DB_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v password="$PLATFORM_APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE platform_app LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app')
\gexec
GRANT CONNECT ON DATABASE platform TO platform_app;
SQL
