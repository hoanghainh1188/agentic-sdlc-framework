#!/bin/sh
# The index of project documents (task X04 PR 3a, design/ADR-M89 §2.1). Runs once, when the
# knowledge-db data volume is empty (docker-entrypoint-initdb.d):
# - the database `knowledge` and the pgvector extension in it (the extension needs the superuser);
# - the role `knowledge`, owner of the database, which creates the per-project schemas and read
#   roles (CREATEROLE). It gets no password here: `pnpm openbao:bootstrap
#   worker-knowledge-credentials` sets a random one and stores it in OpenBao for the worker.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE knowledge NOLOGIN CREATEROLE;
CREATE DATABASE knowledge OWNER knowledge;
REVOKE ALL ON DATABASE knowledge FROM PUBLIC;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname knowledge <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
