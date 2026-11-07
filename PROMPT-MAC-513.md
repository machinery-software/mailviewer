# MAC-513 brief (7 November 2026)

PR 1 of three (MAC-513, then the Safari PDF hint, then an SEO pass), each on its own branch from main, each its own PR. Do not merge or promote. Nothing may add a network request, a tracker or a third-party script; the CSP and the no-transform header stay exactly as they are. Record findings where this repo records them.

## PR 1: MAC-513 (High). .olm has never opened in production

src/.../olm.ts calls new DOMParser(), which does not exist in the parse Web Worker. Tests passed only because they run in jsdom. The site advertises .olm, so this is a live false claim.

1. Replace DOMParser in the .olm path with a DOM-free XML reader that uses no browser-only API (no DOMParser, no document, no window). The same parser is vendored into the Mac app (mailviewer-mac, vendor/mailviewer) and must also run in its parse service, so plain ECMAScript only. Keep zip handling streaming: list headers from the archive's index first, read one message on demand, no full unzip up front.
2. Tests must run where parsers run: execute the .olm parser in a real worker-like context with no DOM globals (Node worker_threads, or the print-suite browsers in a Worker). Show it failing against main ("DOMParser is not defined") before the fix, then passing.
3. Fixtures: a small real Outlook for Mac .olm export (synthetic content). If ~/Downloads/msg-test-files/ has one, use it via js/make-fixtures conventions; otherwise say so and stop short of claiming real-export coverage. Add a truncated and a malformed .olm that each produce one error row, not a hang.
4. Check every format the drop zone and format list advertise (.eml .emlx .msg .oft .mbox .mbx .pst .ost .olm .mht .mhtml, winmail.dat) actually opens in the production build in a real browser worker. Report a table. Anything that doesn't open comes off the advertised list in this PR, with a ticket number. MAC-526 says .pst/.ost lack fixtures; state plainly what you could and could not verify.
5. PR body: before/after on a real .olm in Chromium, Firefox and WebKit; the format table; a device-check line for David (open a real .olm in Safari).

## Findings (7 November)

- No real .olm exists in ~/Downloads/msg-test-files/ (three .msg files only) or anywhere Spotlight indexes. The fixtures are generated (tests/print/formatFixtures.mjs: olmOutlook, olmTruncated, olmMalformed), synthetic content, laid out the way Outlook 2016+ is described as writing an export. Not real-export coverage.
- The old path filter wanted a directory named exactly "Message"/"Messages". Outlook 2016+ is described as writing "com.microsoft.__Messages", which it would have missed even with DOMParser available. Both are now recognised; unverified against a real export.
- Before the fix, a truncated .olm failed with fflate's "invalid zip data" and a malformed one with "DOMParser is not defined"; an archive whose message XML was all malformed would have opened as an empty tree.
- .olm times carry no zone and are parsed as local time. Unverified whether Outlook writes UTC.
- .pst/.ost: no fixture (MAC-526). The parser uses only Blob/TextDecoder/TextEncoder (static audit), and a header-only file reaches the PST reader in the worker in all three engines. Nothing more is verified.
