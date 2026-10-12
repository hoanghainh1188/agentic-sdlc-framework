#!/usr/bin/env bash
# Installs cosign for the release workflows (release-images.yml, release.yml, npm-publish.yml),
# in place of `sigstore/cosign-installer`, whose downloads give up after about 7 seconds of
# network errors (QUESTIONS #420 follow-up: v0.2.0's npm-publish failed three times on HTTP 504
# from GitHub's release downloads while GitHub was degraded).
#
#   install-cosign.sh <version>      for example v3.1.3 (the workflows' COSIGN_VERSION)
#
# Downloads the Linux binary of that version from the official cosign release, retries for about
# three minutes, and checks it against the SHA-256 pinned below before it is run. A version or an
# architecture without a pin is refused: a new cosign version changes COSIGN_VERSION and these
# pins together (copy them from the release's cosign_checksums.txt and check them).
# Prints no secret; needs no token.
set -euo pipefail

version="${1:?usage: install-cosign.sh <version>}"

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "::error::install-cosign: unsupported architecture $(uname -m)"; exit 1 ;;
esac

# SHA-256 of cosign-linux-<arch> per version (from the release's cosign_checksums.txt).
case "$version/$arch" in
  v3.1.3/amd64) sha256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 ;;
  v3.1.3/arm64) sha256=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a ;;
  *) echo "::error::install-cosign: no pinned checksum for $version on $arch"; exit 1 ;;
esac

dir="${RUNNER_TEMP:-$(mktemp -d)}/cosign-bin"
mkdir -p "$dir"
url="https://github.com/sigstore/cosign/releases/download/$version/cosign-linux-$arch"

# Retries every network error and HTTP 5xx: 10 tries, 15 seconds apart, at most 2 minutes each.
curl --fail --silent --show-error --location \
  --retry 10 --retry-all-errors --retry-delay 15 \
  --connect-timeout 20 --max-time 120 \
  --output "$dir/cosign.download" "$url"

echo "$sha256  $dir/cosign.download" | sha256sum --check --status || {
  rm -f "$dir/cosign.download"
  echo "::error::install-cosign: the downloaded cosign does not match the pinned SHA-256"
  exit 1
}
mv "$dir/cosign.download" "$dir/cosign"
chmod 755 "$dir/cosign"
"$dir/cosign" version >/dev/null
if [ -n "${GITHUB_PATH:-}" ]; then echo "$dir" >> "$GITHUB_PATH"; fi
echo "install-cosign: cosign $version ($arch) installed and checked"
