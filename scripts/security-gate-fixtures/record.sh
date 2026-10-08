#!/bin/bash
# Re-record what the scanners say about each fixture lockfile. NEEDS THE
# NETWORK and osv-scanner on PATH; run by hand, never by the tests, which read
# the recorded osv.json and npm-audit.json instead. Advisories are added over
# time, so a re-recording can change what the tests see: check the diff.
set -eu
cd "$(dirname "$0")"
for d in */; do
  d="${d%/}"
  osv-scanner scan source --lockfile "$d/package-lock.json" --format json >"$d/osv.json" || [ $? -eq 1 ]
  (cd "$d" && npm audit --omit=dev --json >npm-audit.json) || true
  echo "$d: recorded"
done
date -u +%Y-%m-%d >RECORDED
