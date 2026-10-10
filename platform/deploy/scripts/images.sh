#!/bin/sh
# Published or locally built platform images (task V04, design/ADR-M66 §2.5).
#
# Usage: platform/deploy/scripts/images.sh mode        # prints `published` or `local`
#        platform/deploy/scripts/images.sh get <NAME>  # prints SDLC_IMAGE_<NAME> of the lock file
#        platform/deploy/scripts/images.sh export      # prints the lock file's NAME=value lines
#
# `published` only on a release checkout, with a complete platform/deploy/images.lock.env:
# - a Git checkout whose HEAD is exactly the tag v$SDLC_IMAGES_VERSION, with no change to a
#   tracked file; or
# - a source archive of the release (no .git), whose root package.json has that version.
# Everything else (main, a branch, a changed file, an empty lock file) builds the images locally.
#
# Environment:
#   SDLC_IMAGES   `published` or `local` overrides the choice (`published` needs a complete lock)
set -eu

NAMES="API WORKER RUNNER OTEL_COLLECTOR SANDBOX_NODE24"
PREFIX="ghcr.io/hoanghainh1188/agentic-sdlc-framework"

root="$(cd "$(dirname "$0")/../../.." && pwd)"
lock="$root/platform/deploy/images.lock.env"

die() { echo "images: $*" >&2; exit 1; }
value() { sed -n "s/^$1=//p" "$lock" | tail -n 1; }

# The image name on GHCR of a lock entry.
image_of() {
  case "$1" in
    SANDBOX_NODE24) echo sandbox-node24 ;;
    OTEL_COLLECTOR) echo sdlc-otel-collector ;;
    *) echo "sdlc-$(echo "$1" | tr '[:upper:]' '[:lower:]')" ;;
  esac
}

# 0 when every entry is set and pinned by digest under the one registry path.
lock_complete() {
  [ -f "$lock" ] || return 1
  printf '%s' "$(value SDLC_IMAGES_VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || return 1
  for n in $NAMES; do
    printf '%s' "$(value "SDLC_IMAGE_$n")" |
      grep -Eq "^$PREFIX/$(image_of "$n")@sha256:[0-9a-f]{64}\$" || return 1
  done
}

release_checkout() {
  version="$(value SDLC_IMAGES_VERSION)"
  if [ -e "$root/.git" ] && command -v git >/dev/null 2>&1; then
    tag="$(git -C "$root" describe --exact-match --tags HEAD 2>/dev/null || true)"
    [ "$tag" = "v$version" ] || return 1
    [ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || return 1
    return 0
  fi
  pkg="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/package.json" | head -n 1)"
  [ "$pkg" = "$version" ]
}

mode() {
  case "${SDLC_IMAGES:-}" in
    local) echo local; return ;;
    published)
      lock_complete || die "SDLC_IMAGES=published, but $lock is not complete"
      echo published
      return
      ;;
    '') ;;
    *) die "SDLC_IMAGES must be published or local, not '$SDLC_IMAGES'" ;;
  esac
  if lock_complete && release_checkout; then echo published; else echo local; fi
}

case "${1:-}" in
  mode) mode ;;
  get)
    [ "$#" -eq 2 ] || die "usage: $0 get <NAME>"
    case " $NAMES " in *" $2 "*) ;; *) die "unknown image $2 (one of: $NAMES)" ;; esac
    lock_complete || die "$lock is not complete (no release with published images)"
    value "SDLC_IMAGE_$2"
    ;;
  export)
    lock_complete || die "$lock is not complete (no release with published images)"
    echo "SDLC_IMAGES_VERSION=$(value SDLC_IMAGES_VERSION)"
    for n in $NAMES; do echo "SDLC_IMAGE_$n=$(value "SDLC_IMAGE_$n")"; done
    ;;
  *) echo "usage: $0 mode | get <NAME> | export" >&2; exit 2 ;;
esac
