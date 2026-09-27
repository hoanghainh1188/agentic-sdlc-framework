#!/bin/sh
# Probes of the C04 live egress test (ADR-M25 §2.2). Reads "name host port" lines from
# /workspace/probe-targets (uploaded by the runner before the start) and prints one line each:
# probe:<name>:open|blocked. GATEWAY stands for the .1 address of the sandbox's own subnet.
self=$(ip -4 -o addr show eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
gateway=$(echo "$self" | awk -F. '{print $1"."$2"."$3".1"}')
while read -r name host port; do
  [ -z "$name" ] && continue
  [ "$host" = GATEWAY ] && host=$gateway
  if nc -z -w 3 "$host" "$port" 2>/dev/null; then echo "probe:$name:open"; else echo "probe:$name:blocked"; fi
done < /workspace/probe-targets
route=$(ip route 2>/dev/null | awk '/^default/ {print $3}')
echo "probe:default_route:${route:-none}"
if touch /rootfs-write-test 2>/dev/null; then echo "probe:rootfs:writable"; else echo "probe:rootfs:readonly"; fi
if touch /workspace/.write-test 2>/dev/null; then echo "probe:workspace:writable"; else echo "probe:workspace:readonly"; fi
echo "probe:uid:$(id -u)"
if env | grep -q "c04-canary"; then echo "probe:canary:present"; else echo "probe:canary:absent"; fi
if env | grep -qiE "^(SDLC_OPENBAO|VAULT|BAO|ANTHROPIC|OPENAI|LITELLM|GITHUB|GH)_"; then echo "probe:secret_env:present"; else echo "probe:secret_env:absent"; fi
echo "probe:done"
exec httpd -f -p 8000 -h /tmp
