# Spike X14: an open-source MCP gateway in front of a run's tools

This is a **spike**, not product code. It may be thrown away after X14. The result is
[`design/ADR-M87-mcp-gateway-spike.md`](../../../design/ADR-M87-mcp-gateway-spike.md).
Nothing in `platform/apps`, `platform/packages` or `platform/eval` imports it, and it changes none
of them.

The repository holds the scripts and the numbers only. Raw logs, metrics and Trivy reports stay in
`$X14_OUT`, outside the repository.

## What it contains

| File | Purpose |
|---|---|
| `tool/server.mjs` | A stub MCP tool over Streamable HTTP, no dependencies: `search_docs` and `delete_docs`. Answers hold an answer canary; `GET /stats` counts the calls that reached it |
| `client/client.mjs` | The stand-in for the sandbox, on the run network only: no key, a wrong key, the tool list, an allowed call, a refused tool, a refused argument, the cap, a direct call to the tool. `LOAD=<n>` makes n allowed calls instead |
| `gateways/agentgateway/` | agentgateway 1.6.0: `config.yaml.tpl` (the key's SHA-256, tool names, the argument rule on the JSON-RPC body, the cap), `start.sh` |
| `gateways/contextforge/` | IBM ContextForge 1.1.0: `plugins.yaml` (SchemaGuard, rate limiter), `bootstrap.mjs` (log in, register the tool, a virtual server, a scoped token), `start.sh` |
| `gateways/docker/` | Docker MCP Gateway 0.44.1: `catalog.yaml` (one remote server), `start.sh` |
| `run.sh` | One run: two internal networks with no bridge address (ADR-M25 §2.2), the tool, the gateway, the client; every container hardened as a sandbox; the logs searched for the query, the answer and the key |
| `scan.sh` | Trivy 0.74.0 (the CI's version) on the three images: vulnerabilities (HIGH, CRITICAL) and licences |
| `summarise.mjs` | Writes `results/<gateway>.json` from `$X14_OUT` |
| `results/` | The numbers (JSON): codes and counts only |

## Run it

Needs Docker, Node.js 24, `openssl` and `curl`. No secret is involved: each run makes a random
key and, for ContextForge, random passwords that live only as long as the run. It does not touch
the platform's dev stack; every object it creates carries the label `x14=spike` and is removed at
the end.

```bash
export X14_OUT="$HOME/.cache/x14-mcp-gateway"
for g in agentgateway contextforge docker; do
  platform/spikes/mcp-gateway/run.sh "$g"                                     # AC2
  X14_CAP=3000 X14_LOAD=2000 platform/spikes/mcp-gateway/run.sh "$g"          # AC3
done
platform/spikes/mcp-gateway/scan.sh                                           # AC1
node platform/spikes/mcp-gateway/summarise.mjs "$X14_OUT"
```

The load run reads CPU time from the Docker stats API on `/var/run/docker.sock` (`DOCKER_SOCK`
to change it).
