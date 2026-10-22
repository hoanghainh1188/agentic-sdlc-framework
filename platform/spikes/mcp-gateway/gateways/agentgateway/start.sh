# X14 spike: agentgateway v1.6.0 (sourced by run.sh). A static config file; no database, no exec.
GW_IMAGE='cr.agentgateway.dev/agentgateway:v1.6.0@sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c'
GW_URL='http://gateway:3000/mcp'

gw_start() {
  sed -e "s/@KEY_HASH@/$KEY_HASH/" -e "s/@CAP@/$CAP/" "$here/gateways/agentgateway/config.yaml.tpl" > "$OUT/cfg/config.yaml"
  docker run -d --name "x14-gw-$ID" $HARDEN --memory 128m --cpus 0.5 \
    --network "$TOOL_NET" -v "$OUT/cfg/config.yaml:/cfg/config.yaml:ro" \
    "$GW_IMAGE" -f /cfg/config.yaml >/dev/null
}

# The call counts the runner could read: the Prometheus endpoint on the stats port.
gw_collect() {
  on_net "$RUN_NET" "$NODE" node -e '
    fetch("http://gateway:15020/metrics").then((r) => r.text()).then((t) =>
      process.stdout.write(t.split("\n").filter((l) => /^agentgateway_mcp|^agentgateway_requests_total/.test(l)).join("\n")));' \
    > "$OUT/extra-metrics.txt" || true
}
