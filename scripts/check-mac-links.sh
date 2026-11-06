#!/usr/bin/env bash
#
# Check that every link on the Mac purchase page answers (MAC-715). Run by
# hand, not in CI or the unit tests: it reaches the network.
#
#   scripts/check-mac-links.sh <site base> [release host base]
#   scripts/check-mac-links.sh https://<preview>.workers.dev https://<staging release host>
#
# Links to the site itself (/, /mac, /#/privacy) are asked of <site base>.
# Links to https://updates.mailviewer.app/ are asked of [release host base]
# when given (staging, until production exists). mailto: links are listed,
# not checked. Plain curl, no cookies: what an admin's own check would see.
set -euo pipefail
SITE="${1:?usage: scripts/check-mac-links.sh <site base> [release host base]}"; SITE="${SITE%/}"
HOST="${2:-https://updates.mailviewer.app}"; HOST="${HOST%/}"
PAGE="$(curl -fsSL "$SITE/mac")" || { echo "FAIL  $SITE/mac does not answer" >&2; exit 1; }
grep -q 'Open any email file on your Mac' <<<"$PAGE" || { echo "FAIL  $SITE/mac is not the purchase page" >&2; exit 1; }
echo "ok    $SITE/mac"
rc=0
while IFS= read -r href; do
  case "$href" in
    "#"*) continue ;;
    mailto:*) echo "mail  $href"; continue ;;
    /*) url="$SITE${href%%#*}" ;;
    https://updates.mailviewer.app/*) url="$HOST/${href#https://updates.mailviewer.app/}" ;;
    *) url="$href" ;;
  esac
  if code="$(curl -fsSL -o /dev/null -w '%{http_code}' "$url")"; then echo "ok    $url ($code)"; else echo "FAIL  $url" >&2; rc=1; fi
done < <(grep -oE 'href="[^"]+"' <<<"$PAGE" | sed 's/^href="//; s/"$//' | sort -u)
exit $rc
