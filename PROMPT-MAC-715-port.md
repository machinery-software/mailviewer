(2026-10-17, David, relayed by the coordinating agent; part A and C of the page port)

The page port. Both source files are in ~/Downloads: mac-index.html and downloads-index.html. They are the design of record; port byte-faithful (same markup, same CSS), changing only what's listed.
A. Web repo, branch feat/mac-715-purchase-page (PR #20), worktree ~/Documents/Github/worktrees/web-mac-715: replace public/mac/index.html with mac-index.html.
   - Keep the CSP in public/_headers unchanged; the page has no script and no external resources, so it must pass as is. If anything violates the CSP, tell me rather than loosening it.
   - The three Buy buttons link to Stripe Payment Links (buy.stripe.com, three URLs in the file); leave them. Put the three URLs in one constants file and add a test that the page's hrefs match it. The Personal button is a disabled "Coming to the Mac App Store". The old MAC-715 button rules are superseded.
   - /mac/terms is linked in the footer; if no terms page exists yet, point it at mailto:support@mailviewer.app and open a ticket.
   - Add a "Mailviewer for Mac" link to the web app's own header pointing at /mac.
   - Tests: the page renders under the CSP with no console violations in the print harness; every href resolves to a real route or an https URL.
   - Run release:preview, give me the staging URL, mark PR #20 ready. Do not promote.
C. Both pages: WCAG AA contrast on the dark palette (text #ECF2F0, #A7B5B1, #6F7D7A on #0B1211 and #131D1B). Report the three ratios. If #6F7D7A fails for body text, use it only for the footer and 14px fine print and say so.

Coordinator's notes:
- Source file: ~/Downloads/mac-index.html (27647 bytes). public/mac/index.html must equal it except the listed changes (the /mac/terms href if no terms page exists, and the contrast restriction if needed). Report a diff of the deployed file vs the source, every changed line.
- The three Stripe URLs stay hard-coded in the static page. The constants file is the single source the test reads; the test asserts the page's buy.stripe.com hrefs equal exactly those three, by tier. No build-time injection.
- The Personal button: if the source already has it disabled "Coming to the Mac App Store", leave it; if not, report rather than redesign.
- Contrast: #6F7D7A (--ink3) fails AA for normal text (4.41:1 / 4.01:1). It may be used only for the footer and <=14px fine print; change only an offending element to var(--ink2) and list it; do not change the palette value; report #788683 (4.99:1 / 4.54:1) as the nearest passing shade. Add a test computing the ratios from the page's CSS variables: ink and ink2 >= 4.5 on both backgrounds; ink3 only in footer/fine-print.
- Header link: "Mailviewer for Mac" -> /mac in the app's header, existing styling; add a test.
- /mac/terms: if no route exists, mailto:support@mailviewer.app and a Linear ticket in team MAC (Medium) to write the terms page and restore the href, referencing PR #20.
- CSP: public/_headers unchanged; verify in the print harness that /mac/ under the real CSP produces no console errors or violations. If anything violates, stop and report.
- Href test: every href is https://, mailto:, an existing #anchor, or a path that resolves to a real route or file in dist/.
- Run the full suites, then npm run release:preview (never release:promote); verify the preview serves the new /mac/ and the CSP header; push; update PR #20's body with a device checklist; gh pr ready 20. Record findings per repo convention.
