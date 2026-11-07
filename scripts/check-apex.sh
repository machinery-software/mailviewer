#!/usr/bin/env bash
#
# Ask the live site, as a browser would, whether the edge has tampered with it.
#
# Why this exists (MAC-515, DEPLOYMENT.md §5a): the mailviewer.app zone has
# twice appended Cloudflare Web Analytics' beacon.min.js to the HTML it serves,
# with no deploy on our side. Two things hide that from every other check:
#
#   - The injection is keyed on the User-Agent. curl's own UA gets the clean
#     body; a browser gets the beacon. So this script sends Safari's UA, and a
#     check without one proves nothing.
#   - It is a zone-level change, so it never shows on a workers.dev preview.
#     Only the apex can show it, and only after a promote.
#
# public/_headers answers with Cache-Control: no-transform, which tells the
# proxy it may not rewrite the body; this script confirms both that the header
# is served and that the body is in fact untouched. Run it after every promote
# (DEPLOYMENT.md §8, step 5) and after any change to the zone.
#
# Usage: scripts/check-apex.sh [base-url]        (default https://mailviewer.app)
# Exit:  0 clean, 1 a finding, 2 a page could not be fetched.

set -uo pipefail

BASE="${1:-https://mailviewer.app}"
BASE="${BASE%/}"
PAGES=("$BASE/" "$BASE/mac/")

# A real browser's User-Agent string, which is the whole point. Safari 18 on
# macOS 14; any current desktop browser's string would do, curl's would not.
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
for url in "${PAGES[@]}"; do
  echo "== $url"
  if ! curl -sS -A "$UA" -D "$tmp/headers" -o "$tmp/body" "$url"; then
    echo "  FAIL  could not fetch"
    exit 2
  fi
  status="$(head -1 "$tmp/headers" | tr -d '\r')"
  case "$status" in
    *" 200"*) echo "  ok    $status" ;;
    *) echo "  FAIL  $status"; fail=1 ;;
  esac
  echo "  info  body $(wc -c < "$tmp/body" | tr -d ' ') bytes"

  for needle in cloudflareinsights beacon.min.js; do
    n="$(grep -c -- "$needle" "$tmp/body" || true)"
    if [ "$n" -eq 0 ]; then
      echo "  ok    body has no '$needle'"
    else
      echo "  FAIL  body contains '$needle' ($n line(s)): the edge is injecting a script"
      grep -n -- "$needle" "$tmp/body" | head -3 | sed 's/^/        /'
      fail=1
    fi
  done

  cc="$(grep -i '^cache-control:' "$tmp/headers" | tr -d '\r' | sed -E 's/^[^:]+:[[:space:]]*//')"
  if [ -z "$cc" ]; then
    echo "  FAIL  no Cache-Control header"
    fail=1
  elif printf '%s' "$cc" | tr ',' '\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g' | grep -qx 'no-transform'; then
    echo "  ok    Cache-Control: $cc"
  else
    echo "  FAIL  Cache-Control lacks no-transform: $cc"
    fail=1
  fi
done

# The files crawlers read, and a path that is not a page. The zone can change
# these too: Cloudflare's managed robots.txt rewrites robots.txt at the edge,
# and the old single-page-application handling answered all three with the
# app and a 200.
fetch_as() { curl -sS -A "$1" -D "$tmp/headers" -o "$tmp/body" "$2"; }
field() { grep -i "^$1:" "$tmp/headers" | tr -d '\r' | sed -E 's/^[^:]+:[[:space:]]*//'; }
code() { head -1 "$tmp/headers" | tr -d '\r' | awk '{print $2}'; }

echo "== $BASE/robots.txt"
if fetch_as "$UA" "$BASE/robots.txt"; then
  ct="$(field content-type)"
  if [ "$(code)" = 200 ] && printf '%s' "$ct" | grep -qi '^text/plain'; then echo "  ok    200 $ct"; else echo "  FAIL  $(code) $ct"; fail=1; fi
  if grep -qx "Sitemap: $BASE/sitemap.xml" "$tmp/body" || grep -qx "Sitemap: https://mailviewer.app/sitemap.xml" "$tmp/body"; then
    echo "  ok    names the sitemap"
  else
    echo "  FAIL  no Sitemap: line for $BASE/sitemap.xml"; fail=1
  fi
  if [ "$(grep -Ecv '^(#.*|User-agent: \*|Allow: /|Sitemap: .*)?$' "$tmp/body")" -ne 0 ]; then
    echo "  FAIL  robots.txt has lines we did not write (managed robots.txt?):"
    grep -Ev '^(#.*|User-agent: \*|Allow: /|Sitemap: .*)?$' "$tmp/body" | head -3 | sed 's/^/        /'
    fail=1
  fi
else
  echo "  FAIL  could not fetch"; fail=1
fi

echo "== $BASE/sitemap.xml"
if fetch_as "$UA" "$BASE/sitemap.xml"; then
  ct="$(field content-type)"
  if [ "$(code)" = 200 ] && printf '%s' "$ct" | grep -qi 'xml' && grep -q '<urlset' "$tmp/body"; then echo "  ok    200 $ct"; else echo "  FAIL  $(code) $ct"; fail=1; fi
else
  echo "  FAIL  could not fetch"; fail=1
fi

echo "== $BASE/no-such-page-check-apex"
if fetch_as "$UA" "$BASE/no-such-page-check-apex"; then
  if [ "$(code)" = 404 ]; then echo "  ok    404"; else echo "  FAIL  $(code): an unknown path should be a 404"; fail=1; fi
else
  echo "  FAIL  could not fetch"; fail=1
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "FAIL: the apex is not serving the site as built. See DEPLOYMENT.md §5a."
  exit 1
fi
echo "OK: no injected script, every HTML response is marked no-transform, and robots.txt, sitemap.xml and 404s are as built."
