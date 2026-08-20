# mailviewer.app — support contact + print-to-PDF truncation

Two user-reported items. Both touch the live app, so they go through the
approval-gated pipeline from PR #1: build, typecheck, tests, preview
smoke-test, then David approves production. Smallest diff that solves each
problem — no refactoring alongside.

**Never deploy. Never self-merge.** Output is a PR.

---

## Item 1 — Users have no way to report bugs

There is currently no support contact anywhere on the page. Add one.

### Constraint that decides the design

**No submission form.** Any in-app form would need to POST somewhere, which
requires relaxing `connect-src 'none'` and breaks the product's central
guarantee. Do not add one, and do not add a third-party widget (Sentry,
Intercom, a feedback SaaS) — same problem, plus it would fail the
external-origins CI check. The contact must be a `mailto:` link, an external
link to a GitHub issues page, or both.

Treat this as something to say out loud rather than apologize for: a line like
"we have no error reporting, because the app can't send anything anywhere"
reinforces the promise instead of reading as a missing feature.

### What to build

- A persistent, discoverable contact affordance — footer link, or a small
  "Report a problem" control in the header. Visible without opening a file,
  since a user whose file failed to load may be looking at an empty state.
- Surface it in the error path too. When a file fails to parse, that error
  state should offer the report link right there. That is the moment a user
  most wants it.
- **Ask David for the address before hardcoding one.** A previous draft
  invented `privacy@mailviewer.app`; do not assume any mailbox exists. If
  there is no address yet, use the GitHub issues URL for the repo and flag it
  in the PR.

### mailto prefill — with a hard rule

Prefilling the subject and a diagnostic body block is worth doing: app version
or commit SHA, browser and OS from the UA, and the *format* that failed
(`pst`, `eml`, …).

**Never include message content, filenames, sender or recipient addresses,
subjects, or any bytes from the user's file.** A single leaked filename in a
prefilled mail body would be a serious breach of the promise for a forensic
tool. Whatever you assemble, write a test asserting the mailto body contains
nothing derived from the loaded file.

Add a short line near the link telling users not to attach confidential email
files to a bug report, and to describe the problem instead. Their files are
often privileged or evidentiary.

If a build-time version identifier is not already exposed, wire the commit SHA
in via Vite `define` so reports are traceable to a build.

---

## Item 2 — Print to PDF only captures the first page

Reported: printing (or Save as PDF) produces only the first page rather than
the full message or thread.

### Likely cause — verify before fixing

The message body is almost certainly rendered in an iframe. **Iframe content
does not paginate across printed pages.** The browser prints the iframe's
visible box and nothing beyond it, so a scrollable iframe yields exactly one
page regardless of content length. Contributing factors to check: fixed
heights or `100vh` on layout ancestors, `overflow: hidden|auto` on the
scrolling container, and any virtualized list rendering only visible rows.

Confirm the actual mechanism before changing anything — reproduce with a long
single message and with a long thread, in Chrome, Safari, and Firefox. They
differ here.

### Preferred fix

**Keep the iframe.** It is a security boundary for untrusted third-party HTML,
and dissolving it to make printing work would trade a real protection for a
convenience. The standard approach that preserves it:

1. On `beforeprint`, measure the body's full content height and set the iframe
   element's height to it, so the parent document paginates a tall element
   rather than clipping a short one.
2. Add an `@media print` stylesheet that removes height and overflow
   constraints from every ancestor of the body, hides chrome (list pane,
   toolbar, search), and sets sensible margins.
3. On `afterprint`, restore the previous height.

**Constraint to resolve first:** if the iframe is sandboxed without
`allow-same-origin`, the parent cannot read `contentDocument.scrollHeight`.
Do not weaken the sandbox to get the measurement. Alternatives: measure the
sanitized HTML in an offscreen element in the parent document, or use a
separate hidden same-origin measuring iframe. If neither works, describe the
constraint in the PR rather than loosening the sandbox.

### "The entire email chain"

The report says the whole chain, so decide deliberately whether print means
the current message or the whole thread, and make it explicit in the UI rather
than implicit. For a forensic tool I would expect an explicit choice — "Print
message" vs "Print thread" — since users are producing exhibits and need to
know exactly what the artifact contains.

If printing a thread, every message must be expanded in the print output
regardless of collapsed state on screen, in thread order, each with a visible
header block (from, to, cc, date, subject) so a printed page is
self-describing. A printed exhibit missing its headers is not much use.

### Verify against real output

Test by actually generating PDFs, not by eyeballing print preview. Playwright's
`page.pdf()` in Chromium can assert page count and that content from the last
message appears in the output. Cover: a long single message, a 10+ message
thread, a message with a wide table (common in insurance and legal mail),
and one with inline images.

---

## Both items

- Regression tests in the same commit as each fix.
- The characterization snapshots must not move except where intended.
- Re-run all three browsers.
- Nothing added may introduce an external origin — the CI check will catch it,
  but do not make it do that work.
- Preview URL smoke-test before requesting approval. Note in the PR what David
  should check by hand: print a real thread to PDF and open the result.

## Conventions

- Git worktree; keep this PROMPT.md in the worktree root.
- Bisect-clean commits, one concern each.
- Dual validation: green CI and David's real-scenario verification.
- Remove the worktree after pushing.
