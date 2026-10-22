#!/bin/sh
# X14 spike (design/ADR-M87): one gateway instance for one run, inside the run's networks.
#   X14_OUT=<folder outside the repository> run.sh agentgateway|contextforge|docker
# Layout (ADR-M69 §2.4, ADR-M25 §2.2), both networks internal with no bridge address:
#   run network  x14-run-<id>:  client (the sandbox stand-in), gateway (alias `gateway`)
#   tool network x14-tool-<id>: gateway, tool (alias `tool`)
# Every container gets the sandbox hardening. Raw logs go to $X14_OUT/<gateway>/, never the repo.
set -eu
: "${X14_OUT:?}"
GW="${1:?gateway name}"
CAP="${X14_CAP:-5}"
here="$(cd "$(dirname "$0")" && pwd)"
NODE='node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2'
ID="$(date +%s)"
RUN_NET="x14-run-$ID"
TOOL_NET="x14-tool-$ID"
OUT="$X14_OUT/$GW${X14_LOAD:+-load}"
mkdir -p "$OUT"
rm -f "$OUT"/*
KEY="$(openssl rand -hex 32)"
KEY_HASH="$(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)"
HARDEN="--read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --label x14=spike"

cleanup() {
  docker rm -f "x14-tool-$ID" "x14-gw-$ID" "x14-gw-$ID-db" >/dev/null 2>&1 || true
  docker network rm "$RUN_NET" "$TOOL_NET" >/dev/null 2>&1 || true
  rm -rf "$OUT/cfg"
}
trap cleanup EXIT

for net in "$RUN_NET" "$TOOL_NET"; do
  docker network create --driver bridge --internal -o com.docker.network.bridge.inhibit_ipv4=true \
    --label x14=spike "$net" >/dev/null
done

docker run -d --name "x14-tool-$ID" $HARDEN --user 1000:1000 --memory 64m --cpus 0.25 \
  --network "$TOOL_NET" --network-alias tool \
  -v "$here/tool/server.mjs:/srv/server.mjs:ro" "$NODE" node /srv/server.mjs >/dev/null

# Runs a short Node script on a network, for probes and the client.
on_net() {
  net="$1"; shift
  docker run --rm $HARDEN --user 1000:1000 --memory 128m --network "$net" \
    -v "$here:/s:ro" "$@"
}

# ADR-M69 §2.4 order: the tool is healthy before the gateway starts. (The Docker gateway lists a
# remote server's tools once at start and does not retry.)
on_net "$TOOL_NET" "$NODE" node -e '
  const end = Date.now() + 30000;
  (async () => { while (Date.now() < end) {
    try { if ((await fetch("http://tool:8080/healthz")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200)); }
    process.exit(1); })();'

mkdir -p "$OUT/cfg"
# shellcheck source=/dev/null
. "$here/gateways/$GW/start.sh"   # defines GW_IMAGE, GW_URL, gw_start, optional gw_bootstrap
t0="$(node -e 'process.stdout.write(String(Date.now()))')"
gw_start
docker network connect --alias gateway "$RUN_NET" "x14-gw-$ID"

# Wait until the gateway answers on the run network (any HTTP status), at most 120 s.
on_net "$RUN_NET" -e GW_URL="$GW_URL" "$NODE" node -e '
  const end = Date.now() + 120000;
  (async () => { while (Date.now() < end) {
    try { await fetch(process.env.GW_URL, { method: "POST", signal: AbortSignal.timeout(2000) }); return; } catch {}
    await new Promise((r) => setTimeout(r, 500)); }
    process.exit(1); })();' || { docker logs "x14-gw-$ID" > "$OUT/gateway.log" 2>&1; echo "gateway never answered"; exit 1; }
t1="$(node -e 'process.stdout.write(String(Date.now()))')"
if command -v gw_bootstrap >/dev/null 2>&1; then gw_bootstrap; fi
docker stats --no-stream --format '{{json .}}' "x14-gw-$ID" > "$OUT/stats-idle.json"

[ -n "${X14_LOAD:-}" ] || on_net "$RUN_NET" -e GW_URL="$GW_URL" -e KEY="${CLIENT_KEY:-$KEY}" -e CAP="$CAP" \
  -e KEY_HEADER="${KEY_HEADER:-authorization}" -e KEY_PREFIX="${KEY_PREFIX:-Bearer }" \
  -e TOOL_URL=http://tool:8080 "$NODE" node /s/client/client.mjs > "$OUT/client.jsonl"
docker stats --no-stream --format '{{json .}}' "x14-gw-$ID" > "$OUT/stats-after.json"

# X14_LOAD=<n>: only n allowed calls in one session (set X14_CAP above n). CPU time comes from
# the Docker stats API before and after (cumulative nanoseconds), memory from samples meanwhile.
cpu_ns() {
  curl -s --unix-socket "${DOCKER_SOCK:-/var/run/docker.sock}" \
    "http://docker/containers/x14-gw-$ID/stats?stream=false&one-shot=true" |
    node -e 'let d="";process.stdin.on("data",(c)=>(d+=c)).on("end",()=>{const j=JSON.parse(d);
      process.stdout.write(`${j.cpu_stats.cpu_usage.total_usage} ${j.memory_stats.usage}`);});'
}
if [ -n "${X14_LOAD:-}" ]; then
  ( while :; do cpu_ns >> "$OUT/stats-load.txt" && echo >> "$OUT/stats-load.txt" || break; done ) &
  sampler=$!
  before="$(cpu_ns)"
  on_net "$RUN_NET" -e GW_URL="$GW_URL" -e KEY="${CLIENT_KEY:-$KEY}" -e LOAD="$X14_LOAD" \
    "$NODE" node /s/client/client.mjs >> "$OUT/client.jsonl"
  after="$(cpu_ns)"
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  peak="$(cut -d' ' -f2 "$OUT/stats-load.txt" | sort -n | tail -1)"
  printf '{"scenario":"load_resources","cpu_ms":%s,"peak_memory_bytes":%s}\n' \
    "$(( (${after%% *} - ${before%% *}) / 1000000 ))" "${peak:-0}" >> "$OUT/client.jsonl"
fi

# What reached the tool, read from the tool network.
on_net "$TOOL_NET" "$NODE" node -e '
  fetch("http://tool:8080/stats").then((r) => r.text()).then((t) => process.stdout.write(t));' > "$OUT/tool-stats.json"

docker logs "x14-gw-$ID" > "$OUT/gateway.log" 2>&1
if command -v gw_collect >/dev/null 2>&1; then gw_collect; fi
# The per-run key, the query and the answer must never be in the gateway's logs (R031).
{
  printf '{"start_ms":%s,' "$((t1 - t0))"
  printf '"log_lines":%s,' "$(wc -l < "$OUT/gateway.log" | tr -d ' ')"
  printf '"log_query_canary":%s,' "$(cat "$OUT"/gateway.log "$OUT"/extra-* 2>/dev/null | grep -c X14QUERYCANARY || true)"
  printf '"log_answer_canary":%s,' "$(cat "$OUT"/gateway.log "$OUT"/extra-* 2>/dev/null | grep -c X14ANSWERCANARY || true)"
  printf '"log_key":%s}\n' "$(cat "$OUT"/gateway.log "$OUT"/extra-* 2>/dev/null | grep -c "$KEY" || true)"
} > "$OUT/leaks.json"
docker image inspect "$GW_IMAGE" --format '{"image":"{{index .RepoDigests 0}}","bytes":{{.Size}}}' > "$OUT/image.json"
cat "$OUT/client.jsonl" "$OUT/tool-stats.json" "$OUT/leaks.json"
