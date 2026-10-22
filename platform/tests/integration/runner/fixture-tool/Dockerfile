# Fixture register tool of the X04 live test (ADR-M69 §2.4): a stub MCP server over Streamable HTTP
# with the tool of `read_documents` (`search_project_docs`) and one tool no permission allows
# (`delete_docs`). Runs as the tools' user, with a health check. Never used outside the tests.
FROM docker.io/library/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2
COPY server.mjs /app/server.mjs
USER 10001:10001
HEALTHCHECK --interval=1s --timeout=2s --retries=60 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/app/server.mjs"]
