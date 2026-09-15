# mailviewer.app — email bodies unreadable on dark backgrounds (MAC-594)

User-reported. Emails carrying their own CSS render poorly against the app's
dark background — typically dark text on a dark canvas.

Production is `a7ce8d93-1f6a-4398-a0a9-302127bcfdd4`. Rollback target if
anything goes wrong: `9b24838a-47b8-4516-84dd-92fc0f193eee`.

**Never deploy. Never self-merge.** Output is a PR.

---

## Scope: fix the message body. Do not build a theme.

This brief covers **only** making message bodies legible. App chrome
light/dark theming is tracked separately in MAC-594 part 2 and is explicitly
out of scope here — do not start it, and do not restructure anything in
anticipation of it.

## Diagnose before changing anything

Establish what is actually happening and report it:

1. What does the app declare for `color-scheme`, and at what level?
2. Does the message iframe inherit it? If the app declares
   `color-scheme: light dark` and the OS is dark, the iframe document may
   inherit dark, which flips the browser's *default* colors inside the email —
   default text becomes light, default background transparent. Email content
   then renders against the app's dark canvas using UA defaults it was never
   designed for.
3. What background, if any, is set on the iframe and on its document?
4. Reproduce concretely: OS in dark mode, open an HTML email that sets text
   colors but no background. A Word/Outlook-generated body is the realistic
   case. Capture a screenshot of the broken state before touching anything.

If the diagnosis turns out to be something other than `color-scheme`
inheritance, say so — the hypothesis is not the requirement.

## The fix

**Message bodies render on a light canvas, always, independent of app chrome.**

Set `color-scheme: light` and an explicit light background on the message
iframe's document. That is the whole intent.

**Do not modify any color the email itself declares.** No inversion, no
"dark-mode-ifying", no filter, no heuristic recoloring, no adjusting text
colors for contrast. If the sender specified a color, it renders as specified.

This is what Apple Mail, Outlook and Gmail all do — HTML email renders on
white even in dark mode. For this product there is a stronger reason:
mailviewer produces exhibits. Recoloring a message alters the document. A
rendering that does not match what the sender sent is a fidelity defect, not a
styling choice.

### Constraints

- Do not weaken the iframe `sandbox` or the CSP. If the fix appears to need
  either, stop and describe why in the PR.
- Whatever is injected into the message document must be minimal and must not
  override sender-declared styles. Prefer the lowest-specificity mechanism
  that works.
- Both render paths must agree. The print path already renders on white
  paper — screen and print currently disagree, and this fix should close that
  gap rather than widen it. Screen/print divergence is the same bug class that
  produced the print-container leak and the 10px measuring-frame collapse.
- Plain-text bodies and RTF-derived bodies go through a different element than
  sanitized HTML. Cover all of them; a fix that only lands on the HTML iframe
  leaves `.msg` and plain-text bodies broken.

## Tests

The recurring failure mode in this codebase is assertions that measure a proxy
rather than what a user sees. Five instances so far, including an entire
parser (`.olm`) that has never once worked while its tests stayed green.

So: assert on **rendered appearance**, not on computed style properties or
emitted CSS text.

1. With the OS/browser in dark mode, render an email that declares text colors
   and no background. Assert legibility via rendered output — screenshot
   comparison or sampled pixel contrast between text and its backdrop. A test
   asserting `color-scheme === 'light'` would pass on a build that is still
   visually broken.
2. Assert sender-declared colors are **unchanged** — an email specifying an
   unusual text color renders in that color, not something "corrected".
3. Cover sanitized HTML, plain text, and RTF-derived bodies.
4. Screen and print produce the same body colors.
5. Run in all three engines, in both light and dark OS preference.

Confirm each new test fails against the current build. A regression test that
has never failed is not yet evidence.

## Fixtures

David has `.eml`, `.mbox` and `.msg` fixtures with end-marker strings,
including a Word-style `.msg` with wrapper CSS. Ask for them rather than
rebuilding — they have been rebuilt twice already for want of being handed
over. You will likely need to add one email that sets text colors without a
background, which is the exact shape that triggers this.

## Out of scope

- App chrome theming, a theme toggle, or persisting a theme preference
- Any change to parsing
- Refactoring beyond what the fix requires

## Conventions

- Git worktree; keep this PROMPT.md in the worktree root.
- Bisect-clean commits, regression test in the same commit as the fix.
- 267 unit tests stay green; nothing may introduce an external origin.
- Dual validation: green CI and David's verification on a preview.
- Remove the worktree after pushing.
