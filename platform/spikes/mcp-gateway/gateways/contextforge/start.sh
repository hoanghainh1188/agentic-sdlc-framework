# X14 spike: IBM ContextForge v1.1.0 (sourced by run.sh). SQLite in a tmpfs, in-memory cache, no
# UI. Its start refuses weak or placeholder secrets, so each run gets random ones (spike only).
GW_IMAGE='ghcr.io/ibm/mcp-context-forge:v1.1.0@sha256:7eb21fb9a8070df59435c03c76c40d8c71230c55ba89f884f2482d2cc81cff1c'
GW_URL='http://gateway:4444/health'
CF_EMAIL='admin@x14.example.com'
CF_PASSWORD="Aa1!$(openssl rand -hex 16)"

gw_start() {
  sed -e "s/@CAP@/$CAP/" "$here/gateways/contextforge/plugins.yaml" > "$OUT/cfg/plugins.yaml"
  docker run -d --name "x14-gw-$ID" $HARDEN --memory 1g --cpus 1 \
    --tmpfs /tmp:rw,size=256m --tmpfs /app/logs:rw,size=16m \
    --network "$TOOL_NET" -v "$OUT/cfg/plugins.yaml:/cfg/plugins.yaml:ro" \
    -e HOST=0.0.0.0 -e PORT=4444 -e DATABASE_URL=sqlite:////tmp/mcp.db -e CACHE_TYPE=memory \
    -e MCPGATEWAY_UI_ENABLED=false -e MCPGATEWAY_ADMIN_API_ENABLED=true \
    -e PLUGINS_ENABLED=true -e PLUGINS_CONFIG_FILE=/cfg/plugins.yaml \
    -e SSRF_ALLOW_PRIVATE_NETWORKS=true -e LOG_TO_FILE=false -e LOG_LEVEL=INFO \
    -e GUNICORN_WORKERS=1 -e EMAIL_AUTH_ENABLED=true -e PASSWORD_CHANGE_ENFORCEMENT_ENABLED=false \
    -e PLATFORM_ADMIN_EMAIL="$CF_EMAIL" -e PLATFORM_ADMIN_PASSWORD="$CF_PASSWORD" \
    -e JWT_SECRET_KEY="$(openssl rand -hex 32)" -e AUTH_ENCRYPTION_SECRET="$(openssl rand -hex 32)" \
    -e BASIC_AUTH_PASSWORD="Aa1!$(openssl rand -hex 16)" -e DEFAULT_USER_PASSWORD="Aa1!$(openssl rand -hex 16)" \
    "$GW_IMAGE" >/dev/null
}

gw_bootstrap() {
  out="$(on_net "$RUN_NET" -e CF_EMAIL="$CF_EMAIL" -e CF_PASSWORD="$CF_PASSWORD" "$NODE" \
    node /s/gateways/contextforge/bootstrap.mjs 2> "$OUT/bootstrap.err")" || true
  [ -n "$out" ] || { cat "$OUT/bootstrap.err"; docker logs "x14-gw-$ID" > "$OUT/gateway.log" 2>&1; exit 1; }
  GW_URL="http://gateway:4444/servers/${out%% *}/mcp"
  CLIENT_KEY="${out#* }"
  KEY="$CLIENT_KEY"
}
