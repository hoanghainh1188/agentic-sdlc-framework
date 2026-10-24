#!/usr/bin/env bash
# Verifies the release images before anything is released (task V12, RELEASING.md, QUESTIONS #390).
# Used by both tag workflows, release.yml and npm-publish.yml, so they can never disagree.
#
#   verify-images.sh <file with one image reference per line>
#
# Every reference (ghcr.io/…@sha256:…, from release-check.mjs --images-out) must carry a cosign
# signature and a GitHub build provenance attestation whose certificate names exactly
# release-images.yml on refs/heads/main (checked against the v0.1.1 bundles on 2026-10-10).
# Needs cosign 3.x and gh (GH_TOKEN with attestations: read). Prints no secret.
set -euo pipefail

SIGNER_IDENTITY='https://github.com/hoanghainh1188/agentic-sdlc-framework/.github/workflows/release-images.yml@refs/heads/main'
SIGNER_ISSUER='https://token.actions.githubusercontent.com'
REPO='hoanghainh1188/agentic-sdlc-framework'

file="${1:?usage: verify-images.sh <images file>}"
count=0
while read -r ref; do
  [ -n "$ref" ] || continue
  echo "::group::$ref"
  cosign verify --certificate-identity "$SIGNER_IDENTITY" \
    --certificate-oidc-issuer "$SIGNER_ISSUER" "$ref" > /dev/null
  gh attestation verify "oci://$ref" --repo "$REPO" \
    --cert-identity "$SIGNER_IDENTITY" --cert-oidc-issuer "$SIGNER_ISSUER" > /dev/null
  echo "::endgroup::"
  count=$((count + 1))
done < "$file"
if [ "$count" != 6 ]; then
  echo "::error::expected six images, verified $count"
  exit 1
fi
echo "verify-images: six images signed and attested by release-images.yml on main"
