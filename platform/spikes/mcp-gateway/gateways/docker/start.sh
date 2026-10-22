# X14 spike: Docker MCP Gateway v0.44.1 (sourced by run.sh), without the Docker socket: one remote
# server from a catalog file, only the `search_docs` tool, streaming transport. The per-run key is
# the gateway's bearer token, which it reads from an environment value only.
GW_IMAGE='docker/mcp-gateway:v0.44.1@sha256:b0a3876ffbb352813d658cf25c137b8eae29bbe23db5944560a1c9059533bb16'
GW_URL='http://gateway:3000/mcp'

gw_start() {
  mkdir -p "$OUT/cfg/mcp/catalogs"
  cp "$here/gateways/docker/catalog.yaml" "$OUT/cfg/mcp/catalogs/x14.yaml"
  printf 'registry:\n  docs:\n    ref: ""\n' > "$OUT/cfg/mcp/registry.yaml"
  docker run -d --name "x14-gw-$ID" $HARDEN --user 1000:1000 --memory 128m --cpus 0.5 \
    --tmpfs /tmp:rw,size=16m -e HOME=/home/x14 -e MCP_GATEWAY_AUTH_TOKEN="$KEY" -e DOCKER_MCP_ALLOW_INSECURE_REMOTE_URLS=1 \
    -v "$OUT/cfg/mcp:/home/x14/.docker/mcp:ro" --network "$TOOL_NET" \
    "$GW_IMAGE" --catalog x14.yaml --servers docs --tools search_docs \
    --transport streaming --port 3000 --host 0.0.0.0 --static >/dev/null
}
