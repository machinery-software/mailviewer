# mailviewer.app — two print bugs from the PR #2 staging preview

Found on the staging preview of PR #2 (`fix/support-and-print`). Both block the
deploy. Bug 1 is a visible regression introduced by the print fix itself, so
this cannot ship as-is.

Not deployed, not merged. Production remains on version
`9b24838a-47b8-4516-84dd-92fc0f193eee` (commit `7d30a90`).

**Never deploy. Never self-merge.** Output is a PR.

---

## Bug 1 (P0) — print container leaks into the on-screen UI in Safari

A line of message body text renders across the middle of the live app window,
overlapping the message list and reading pane. Not in print output — in normal
on-screen use.

Observed: Safari, `staging-mailviewer.patchable-account.workers.dev`, with
`2-twelve-messages.mbox` loaded and message 1 open. A single unwrapped line of
body text ("…onfirmed that no temporary repairs had been undertaken prior to
inspection. Following the storm event of 12 March…") painted at roughly
mid-viewport, clipped at the left edge and running off the right.

### Hypothesis — verify, don't assume

The off-screen print document is not fully contained. If it is hidden by
position offset alone (e.g. `left: -10000px`) with no width constraint, and it
renders body text in a non-wrapping element, one paragraph becomes a single line
far wider than the offset, so the right-hand end of it re-enters the viewport.
Clipped-at-the-left is the signature of an element starting left of the viewport
origin. Chromium and Firefox lay this out differently, which is why they did not
show it.

### Fix direction

Contain it rather than merely displacing it: a zero-size, `overflow: hidden`
wrapper, or keep it out of the render tree entirely except under
`@media print`. Whatever the mechanism, the print document must have no
on-screen visual footprint at any viewport size or zoom level.

### Test that would have caught it

Assert the print container's bounding box is zero-area (or that it is not in the
render tree) while on screen, in every engine. Add this even if the fix seems
obviously correct — "the print fix drew garbage into the live UI" is a failure
mode nothing currently asserts against.

---

## Bug 2 (P1) — `.msg` files still print only the first page

The original bug, unfixed for `.msg`. HTML-bodied `.eml` now paginates
correctly; `.msg` does not.

### Hypothesis — verify, don't assume

`.msg` bodies commonly arrive as compressed RTF (hence `lzfu.ts` / `rtf.ts`) or
plain text, and are likely rendered through a different element than sanitized
HTML — a `<pre>` or similar rather than the iframe. If the print path measures
and expands only the iframe, every non-HTML body is still clipped to one page.

Note this predicts the bug is **not** `.msg`-specific — it should affect any
plain-text or RTF-derived body, including a long plain-text `.eml`. Check that
before scoping the fix to `.msg`; the earlier round of manual testing used
HTML-bodied fixtures, which is likely why it went unnoticed.

The two bugs may share this root: a non-wrapping `<pre>` in the print document
would explain both the missing pagination and the enormous width in Bug 1.

### Fix direction

Every body render path must be measured and paginated, not just the iframe path.
Prefer one code path over per-format special-casing.

### Required test coverage before this is done

Existing print tests pass on all three engines and caught neither bug, so the
assertions are insufficient — not the engine list.

Add:

- Print container has no on-screen visual footprint (all engines).
- A `.msg` fixture with a multi-page body, asserting page count > 1 and that the
  final line of content is present in the generated PDF.
- A long plain-text body (not HTML) with the same assertions.
- RTF-derived body from `.msg`, same assertions.
- Keep the existing HTML and 12-message mbox cases.

Assert against real generated PDF output — page count and last-line presence —
not print preview or DOM state.

### Reproduction fixtures

`1-long-single.eml` (long plain-text body), `2-twelve-messages.mbox`,
`3-wide-table.eml`, `4-inline-images.eml` — each contains a unique end-marker
string (`END-OF-DOCUMENT-MARKER`, `MESSAGE-12-END`, `WIDE-TABLE-END-MARKER`,
`INLINE-IMAGES-END-MARKER`) so truncation is detectable by searching the PDF.
Ask David for these. You will need to construct a `.msg` fixture yourself —
there is no `.msg` in that set, which is part of how this was missed.

---

## Constraints

- Smallest diff. No refactoring beyond what the fix requires.
- Do not weaken the iframe sandbox or the CSP to make printing work.
- Existing 265 unit tests must stay green; snapshots must not move except where
  intended.
- Nothing may introduce an external origin.
- Note in the PR that **Safari must be re-checked by hand** on the new preview —
  headless WebKit passed while real Safari failed, so automated coverage in that
  engine is necessary but not sufficient here.

## Conventions

- Git worktree; keep this `PROMPT.md` in the worktree root.
- Bisect-clean commits, one bug per commit, regression test in the same commit.
- Dual validation: green CI and David's verification.
- Remove the worktree after pushing.
