#!/usr/bin/env bash
#
# Fail if the built output references an external origin that is not on the
# allowlist below.
#
# Why this exists: the privacy guarantee of this app is that it never talks to
# anything. The CSP enforces that at runtime, but a dependency upgrade could
# quietly introduce a CDN reference, a telemetry endpoint or a webfont URL that
# nobody notices until it shows up in someone's DevTools. This check is the
# mechanical tripwire for that class of drift -- it reads the actual build
# artifact, not the source, so it sees whatever the bundler really emitted.
#
# Every entry on the allowlist is here because it was found in the build and
# individually justified. Do not add to it without doing the same. If a new
# origin appears, the correct first question is "why is this in our bundle",
# not "how do I make the check pass".
#
# Usage: scripts/check-external-origins.sh [dist-dir]

set -euo pipefail

DIST="${1:-dist}"

if [ ! -d "$DIST" ]; then
  echo "error: '$DIST' does not exist. Run 'npm run build' first." >&2
  exit 2
fi

# --- Allowlist -------------------------------------------------------------
#
# www.w3.org
#   XML/SVG namespace URIs (xmlns, setAttributeNS, xlink:*). These are
#   identifiers, not addresses; a namespace URI is never dereferenced by any
#   browser. Present in React's DOM code and in favicon.svg.
#
# react.dev
#   React builds its minified-error help link as "https://react.dev/errors/"+code
#   and prints it in a thrown Error message. It is a string in an error path and
#   is never fetched.
#
# example.com
#   Deliberate. src/lib/netguard.ts:attemptExfiltration() POSTs to
#   https://example.com/mailviewer-csp-self-test so the browser can refuse it in
#   front of the user. This is the live proof that connect-src 'none' is being
#   enforced -- it is the feature, not a leak. The second occurrence is UI copy
#   quoting the console error the user should expect to see.
#   DO NOT "fix" this by removing it. It is load-bearing for the product's claim.
#
# machinery.software, github.com
#   Two <a href> targets in the footer (vendor attribution and the source repo).
#   Link targets are user-initiated top-level navigation, not subresource loads:
#   nothing is requested unless the reader clicks, and no message data is in the
#   URL.
#
ALLOWED_HOSTS=(
  "www.w3.org"
  "react.dev"
  "example.com"
  "machinery.software"
  "github.com"
)
# ---------------------------------------------------------------------------

# Collect every http(s) URL in the build and reduce each to its host.
found_hosts="$(
  grep -rhoE 'https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+' "$DIST" 2>/dev/null \
    | sed -E 's#^https?://([^/:]+).*#\1#' \
    | sort -u || true
)"

violations=()
while IFS= read -r host; do
  [ -z "$host" ] && continue
  ok=0
  for allowed in "${ALLOWED_HOSTS[@]}"; do
    if [ "$host" = "$allowed" ]; then ok=1; break; fi
  done
  [ "$ok" -eq 0 ] && violations+=("$host")
done <<< "$found_hosts"

echo "External origins referenced in $DIST/:"
while IFS= read -r host; do
  [ -z "$host" ] && continue
  for allowed in "${ALLOWED_HOSTS[@]}"; do
    if [ "$host" = "$allowed" ]; then echo "  ok    $host"; fi
  done
done <<< "$found_hosts"

if [ "${#violations[@]}" -gt 0 ]; then
  echo
  echo "::error::Unapproved external origin(s) in the build output:"
  for v in "${violations[@]}"; do
    echo "  FAIL  $v"
    grep -rnoE ".{60}https?://${v//./\\.}[^\"' ]*" "$DIST" 2>/dev/null | head -3 | sed 's/^/        /'
  done
  echo
  echo "This app promises it never contacts a third party. A new origin in the"
  echo "bundle means a dependency changed that assumption. Investigate why it is"
  echo "there before considering the allowlist in $0."
  exit 1
fi

echo
echo "OK: no unapproved external origins."
