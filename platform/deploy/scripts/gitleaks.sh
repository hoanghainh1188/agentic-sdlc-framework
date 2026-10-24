#!/bin/sh
# Fetches Gitleaks for the runner's secret scan of a run's diff (task H04, design/ADR-M93 §2.1).
# Pinned by version and SHA-256: the same version as the CI `scan` job (`GITLEAKS_VERSION` in
# .github/workflows/ci.yml; a unit test keeps them equal).
#
# Usage: platform/deploy/scripts/gitleaks.sh   → prints the path of the executable
#
# - Downloads the archive from the Gitleaks GitHub release, checks its SHA-256 against the list
#   below (from the release's `gitleaks_<VERSION>_checksums.txt`), and extracts the executable.
# - Used by the runner image (build stage), by the CI jobs that run the runner in-process, and on a
#   developer machine: `export SDLC_RUNNER_GITLEAKS_PATH="$(platform/deploy/scripts/gitleaks.sh)"`.
# - Cache: SDLC_GITLEAKS_DIR (default ~/.cache/sdlc/gitleaks) keeps the archive; it is checked
#   again on every run and the executable extracted again, so a changed cache is never run.
# - To upgrade: change VERSION and the four digests here and `GITLEAKS_VERSION` and
#   `GITLEAKS_SHA256` in ci.yml in the same PR.
set -eu

VERSION=8.30.1

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=linux_x64; sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Linux/aarch64 | Linux/arm64) asset=linux_arm64; sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  Darwin/arm64) asset=darwin_arm64; sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin/x86_64) asset=darwin_x64; sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  *) echo "gitleaks: unsupported platform $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac

dir="${SDLC_GITLEAKS_DIR:-$HOME/.cache/sdlc/gitleaks}/$VERSION"
name="gitleaks_${VERSION}_${asset}"
archive="$dir/$name.tar.gz"
url="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${name}.tar.gz"
mkdir -p "$dir"

sha256_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d ' ' -f 1; }

if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$sha" ]; then
  tmp="$(mktemp "$dir/download.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT INT TERM
  curl -fsSL --proto '=https' --retry 3 -o "$tmp" "$url"
  actual="$(sha256_of "$tmp")"
  if [ "$actual" != "$sha" ]; then
    echo "gitleaks: SHA-256 mismatch for $name (expected $sha, got $actual)" >&2
    exit 1
  fi
  mv "$tmp" "$archive"
fi

rm -rf "$dir/$name"
mkdir -p "$dir/$name"
tar -xzf "$archive" -C "$dir/$name" gitleaks
chmod 755 "$dir/$name/gitleaks"
echo "$dir/$name/gitleaks"
