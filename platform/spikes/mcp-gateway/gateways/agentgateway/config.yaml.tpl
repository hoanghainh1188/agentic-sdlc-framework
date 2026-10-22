# X14 spike (design/ADR-M87): agentgateway v1.6.0, one instance per run.
# run.sh replaces @KEY_HASH@ (sha256 of the per-run key; the key itself is never in the file)
# and @CAP@ (tool calls per run).
config:
  adminAddr: "off"
  statsAddr: 0.0.0.0:15020
  readinessAddr: 0.0.0.0:15021
  logging:
    format: json
    # One line per request; the runner can read these through the Docker logs endpoint it
    # already has. Codes only: the MCP method and the tool name, never arguments or results.
    fields:
      add:
        mcp_method: 'mcp.methodName'
        mcp_tool: 'mcp.tool.name'
binds:
- port: 3000
  listeners:
  - routes:
    - policies:
        apiKey:
          mode: strict
          keys:
          - keyHash: "sha256:@KEY_HASH@"
            metadata:
              run: x14
        # Argument rules: the MCP authorization context of v1.6.0 has the tool's target and name
        # only, so argument rules use HTTP authorization on the JSON-RPC body. A batch, a body
        # over the buffer limit or a body that does not parse fails the rule, so it is refused.
        authorization:
          rules:
          - require: 'request.method != "POST" || json(request.body).with(b, b.method != "tools/call" || !has(b.params.arguments.limit) || double(b.params.arguments.limit) <= 20.0)'
        mcpAuthorization:
          rules:
          - allow: 'mcp.tool.name == "search_docs"'
        localRateLimit:
          conditional:
          - condition: 'mcp.methodName == "tools/call"'
            maxTokens: @CAP@
            tokensPerFill: 1
            fillInterval: 87600h
            type: requests
      backends:
      - mcp:
          statefulMode: stateful
          targets:
          - name: docs
            mcp:
              host: http://tool:8080/mcp
