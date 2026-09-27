#!/bin/sh
# Fetches the Temporal time-skipping test server for the intent workflow tests (task B07,
# design/ADR-M30 §2.6, QUESTIONS #92). Pinned by version and SHA-256; the SDK's own download
# (temporal.download, no checksum) is never used.
#
# Usage: platform/deploy/scripts/temporal-test-server.sh   → prints the path of the executable
#
# - Downloads the archive from the sdk-java GitHub release, checks its SHA-256 against the list
#   below (the digests GitHub publishes for the release assets), and extracts the executable.
# - Cache: SDLC_TEMPORAL_TEST_SERVER_DIR (default ~/.cache/sdlc/temporal-test-server) keeps the
#   archive; CI caches the folder (key: this file's hash). The cached archive is checked again on
#   every run and the executable extracted again, so a changed cache is never run.
# - To upgrade: change VERSION and the four digests in the same PR, from
#   `gh api repos/temporalio/sdk-java/releases/tags/v<VERSION> --jq '.assets[] | [.name, .digest]'`.
set -eu

VERSION=1.39.0

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=linux_amd64; sha=ecd629dceccfbf49d422894bf72fb691a6062b558e72bd2722450dadf7d0c749 ;;
  Linux/aarch64 | Linux/arm64) asset=linux_arm64; sha=0c09117c4f7474e8893aa798538fdd0534d78c0168d472da55f86f5c05d123e2 ;;
  Darwin/arm64) asset=macOS_arm64; sha=9a9395257fb8d585a4eb06b14d26f5d59a516bc1f860fec82381bb30b505f0a7 ;;
  Darwin/x86_64) asset=macOS_amd64; sha=276472e67f73357db8117fec4c13bafd192f80cb427ce7a63cadbbf8be5f03de ;;
  *) echo "temporal-test-server: unsupported platform $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

dir="${SDLC_TEMPORAL_TEST_SERVER_DIR:-$HOME/.cache/sdlc/temporal-test-server}/$VERSION"
name="temporal-test-server_${VERSION}_${asset}"
archive="$dir/$name.tar.gz"
url="https://github.com/temporalio/sdk-java/releases/download/v${VERSION}/${name}.tar.gz"
mkdir -p "$dir"

sha256_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d ' ' -f 1; }

if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$sha" ]; then
  tmp="$(mktemp "$dir/download.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT INT TERM
  curl -fsSL --proto '=https' --retry 3 -o "$tmp" "$url"
  actual="$(sha256_of "$tmp")"
  if [ "$actual" != "$sha" ]; then
    echo "temporal-test-server: SHA-256 mismatch for $name (expected $sha, got $actual)" >&2
    exit 1
  fi
  mv "$tmp" "$archive"
fi

rm -rf "$dir/$name"
tar -xzf "$archive" -C "$dir" "$name/temporal-test-server"
chmod 755 "$dir/$name/temporal-test-server"
echo "$dir/$name/temporal-test-server"
