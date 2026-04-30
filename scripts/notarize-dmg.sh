#!/bin/bash
# Notarize + staple one or more DMGs.
#
# Why this is needed:
#   afterSign notarizes the .app BEFORE the DMG is assembled. The DMG itself
#   is built afterwards, so Apple has never seen it. Submitting each DMG
#   separately gives it its own notarization ticket; `stapler staple` then
#   embeds the ticket in the DMG so users can install offline (without
#   Gatekeeper needing to phone home to Apple).
#
# Usage:
#   ./scripts/notarize-dmg.sh dist/ProductionBuddy-1.0.3-arm64.dmg
#   ./scripts/notarize-dmg.sh dist/*.dmg

set -euo pipefail

: "${NOTARIZE_APPLE_ID:?NOTARIZE_APPLE_ID not set — check ~/.zshrc}"
: "${NOTARIZE_APP_PASSWORD:?NOTARIZE_APP_PASSWORD not set — check ~/.zshrc}"
: "${NOTARIZE_TEAM_ID:?NOTARIZE_TEAM_ID not set — check ~/.zshrc}"

if [ $# -eq 0 ]; then
    echo "Usage: $0 <dmg> [more-dmgs…]"
    exit 1
fi

for f in "$@"; do
    if [ ! -f "$f" ]; then
        echo "❌ $f — file not found, skipping"
        continue
    fi
    echo ""
    echo "=== $f ==="
    echo "Submitting to Apple notary service…"
    xcrun notarytool submit "$f" \
        --apple-id "$NOTARIZE_APPLE_ID" \
        --team-id "$NOTARIZE_TEAM_ID" \
        --password "$NOTARIZE_APP_PASSWORD" \
        --wait

    echo "Stapling ticket…"
    xcrun stapler staple "$f"
    echo "✅ $f notarized + stapled"
done

echo ""
echo "Done. Verify with:"
echo "  spctl -a -t open --context context:primary-signature -vvv <file.dmg>"
