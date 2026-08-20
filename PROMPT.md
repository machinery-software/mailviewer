# mailviewer.app — print dialog deferred; user activation lost before print()

Blocks the deploy. Found on `staging2-mailviewer.patchable-account.workers.dev`,
the preview built from `fix/print-onscreen-leak-and-nonhtml` (PR #3).

Production remains on `9b24838a-47b8-4516-84dd-92fc0f193eee` (commit `7d30a90`).

**Never deploy. Never self-merge.** Output is a PR.

## Symptom

The **Print ▾** control opens and both scope options render ("This message",
"All N messages listed"). Clicking either does nothing at all — no system print
dialog, no visible change, no error dialog. Observed in Safari.

Crucially: **the dialog appears on the next interaction.** Click a scope option,
nothing happens; click anything else on the page, and the print dialog opens.
The call is not failing — it is being deferred.

Printing works for `.mbox` and fails this way for `.msg`. The `.msg` body renders
correctly on screen; only printing is affected.

Reproduces in both Safari and Chrome. This is not a WebKit quirk — Chromium
enforces transient user activation for `print()` on the same terms, which is
exactly what the activation hypothesis below predicts. It also means you can
reproduce and regression-test this in headless Chromium; real Safari is not
required to verify the fix, though David will still check it by hand.

## Hypothesis — strong, but verify

The print dialog does eventually appear: clicking a scope option does nothing,
and then the next click anywhere in the page brings up the print dialog. So
`window.print()` is being called — it is being *deferred*.

That is the signature of losing **transient user activation**. WebKit only opens
the print modal while a user gesture is still live (a few seconds). If the click
handler performs async work first — constructing the off-screen print document,
awaiting a frame `load` event, measuring content height — the activation can
expire before `print()` runs, and Safari defers the modal until the next user
interaction.

This explains the format split without any format-specific bug: `.msg` bodies
require binary `PidTagBodyHtml` decoding and/or RTF conversion and are larger, so
the prepare step overruns the activation window that `.mbox` completes inside.
`.mbox` is not correct — it is merely fast enough. A large enough `.mbox` or
`.pst` message should fail the same way. Treat this as one latent bug affecting
all formats, not a `.msg` bug.

Verify by measuring the elapsed time between the click handler starting and
`print()` being called, per format. **Do not scope the fix to `.msg`.**

## Fix direction

**Do no async work between the user gesture and `window.print()`.**

Prepare the print document when the menu *opens* — that is itself a user
gesture, and it gives the frame time to load and be measured while the user is
reading the options. Clicking a scope option then calls `print()` synchronously
against an already-built document. Rebuild or invalidate when the selected
message or scope changes.

If any preparation must remain in the option-click path, it has to complete
synchronously. Anything awaiting a `load` event does not qualify.

Both PR #3 fixes must survive: the container stays invisible on screen at every
width and zoom, and non-HTML and viewport-pinned bodies still paginate fully.

Also keep both constraints from PR #3 satisfied at once: the print container must
be invisible on screen at every viewport width and zoom level, **and** laid out
enough that frames inside it load and can be measured. Do not trade one for the
other.

## Scope: every format, not just `.msg`

Fix this for all supported message types. `.msg` is where it surfaced, not where
it lives. The bug is in the shared path between the scope-option click and
`window.print()`, and every format traverses it. `.mbox` passes only because its
prepare step happens to finish inside the activation window — a large enough
`.mbox` message should fail identically. Confirm that; it is the cheapest way to
prove the diagnosis.

A `.msg`-only fix or special case is not acceptable. It would leave the defect in
place for every other format while appearing resolved.

Formats to cover, per the parsers in this repo: `.eml`, `.emlx`, `.msg`, `.oft`,
`.mbox`, `.pst`, `.ost`, `.olm`, `.mht`/`.mhtml`, and TNEF (`winmail.dat`). Body
shapes that reach the renderer differently and must each be exercised: sanitized
HTML, plain text, RTF-derived HTML (lzfu → rtf), `PidTagBodyHtml` stored as
`PT_BINARY`, and viewport-pinned wrapper CSS (`height: 100vh`).

Both print scopes — "This message" and "All N messages listed" — for each. The
all-messages scope does proportionally more preparation work, so it is the most
likely to exceed the activation window and the most important to measure. If
preparation time scales with message count, say so explicitly in the PR and
state where the ceiling is.

## The test gap that let this through — fix this too

The existing 23 print tests generate PDFs via Playwright's `page.pdf()`, which
does not exercise the application's own print controls at all. Every one of them
passed while the user-facing button was completely non-functional.

This is the third time in this sequence that green tests measured something
other than the thing users touch. Add tests that:

- **Drive the actual UI control** — click Print ▾, click each scope option, and
  assert the print flow is invoked (stub `window.print` and assert it was
  called, with the expected scope). Do this per format: `.eml`, `.mbox`, and
  `.msg` in each of its body shapes — and the rest of the formats listed under
  Scope above. Asserting `print()` was called is **not sufficient** — it is
  being called today, and the feature is still broken. The test must assert it
  is called **while user activation is still valid**: synchronously within the
  click handler's gesture, with no awaited work in between. Assert on elapsed
  time between gesture and call, or on `navigator.userActivation.isActive` at
  the moment of the call. A test that only checks "print was invoked" passes on
  the current broken build.
- **Assert the flow completes rather than hangs** — fail on timeout, so a
  never-resolving promise is a test failure and not a silent pass.
- **Assert the frames inside the print container actually load** (`load` event
  fires, measured height is greater than a trivial placeholder).
- **Keep the Bug 1 assertion from PR #3** — screenshot comparison with and
  without the print document present.
- **Keep the existing page-count and end-marker assertions** against real
  generated PDFs.

Run across all three engines. Note that headless WebKit has already passed once
while real Safari failed, so David re-tests Safari by hand regardless.

## Fixtures

David has `.eml`, `.mbox` and `.msg` fixtures with unique end-marker strings.
Fixtures do not exist yet for `.emlx`, `.oft`, `.pst`/`.ost`, `.olm`, `.mht` or
TNEF — build them, since the scope above requires covering those paths too.
Existing fixture markers (`END-OF-DOCUMENT-MARKER`, `MESSAGE-12-END`,
`WIDE-TABLE-END-MARKER`, `INLINE-IMAGES-END-MARKER`, `MSG-WORD-END-MARKER`,
`MSG-PLAIN-END-MARKER`, `MSG-HTML-END-MARKER`). Ask for them rather than
rebuilding — the `.msg` set includes a Word-style body with `height: 100vh`
wrapper CSS built specifically to exercise the measuring-frame collapse you
diagnosed.

## Constraints

- Smallest diff. No refactoring beyond the fix.
- Do not weaken the iframe sandbox or the CSP.
- 267 unit tests stay green.
- Nothing may introduce an external origin.

## Conventions

- Git worktree; keep this `PROMPT.md` in the worktree root.
- Bisect-clean commits, regression test in the same commit as the fix.
- Dual validation: green CI and David's verification.
- Remove the worktree after pushing.
