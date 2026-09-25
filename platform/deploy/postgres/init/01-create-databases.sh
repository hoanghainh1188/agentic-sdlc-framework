#!/bin/sh
# Creates one database and one owner role per component (D-03 section 10; task A02).
# Runs once, when the PostgreSQL data volume is empty (docker-entrypoint-initdb.d).
# Passwords come from the environment; they are passed to psql as variables,
# never interpolated into SQL text.
set -eu

create_db() {
  role="$1"
  password="$2"
  shift 2
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v role="$role" -v password="$password" <<'SQL'
CREATE ROLE :"role" LOGIN PASSWORD :'password';
SQL
  for db in "$@"; do
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
      -v role="$role" -v db="$db" <<'SQL'
CREATE DATABASE :"db" OWNER :"role";
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
SQL
  done
}

create_db platform "$PLATFORM_DB_PASSWORD" platform
create_db temporal "$TEMPORAL_DB_PASSWORD" temporal temporal_visibility
create_db litellm "$LITELLM_DB_PASSWORD" litellm
create_db langfuse "$LANGFUSE_DB_PASSWORD" langfuse
