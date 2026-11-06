(2026-11-05, David; the brief for MAC-787, relayed in two messages and the ticket)

Work in the web repo (mailviewer.app), in a worktree from origin/main. Read CLAUDE.md and the /mac purchase page from PR #20 (merge state: check; if #20 is still open, base on its branch and say so).

Changes to the /mac page:
1. Site card: a 1 year / 2 years / 3 years choice (segmented control, 1 year default). The card shows the per-year price for the chosen term ($6,000, $5,700 per year, $5,400 per year) and the total for multi-year ("$11,400 billed once for 2 years", "$16,200 billed once for 3 years"). The Buy button links to the matching Stripe link:
   1 year  https://buy.stripe.com/eVqcN71Uc1GK94p3pw3Nm09
   2 years https://buy.stripe.com/14AeVfeGYetweoJf8e3Nm0a
   3 years https://buy.stripe.com/4gM6oJgP6dpsa8tf8e3Nm0b
   Keyboard-reachable, works without JavaScript (default to the 1-year link).
2. Under the pricing cards, one line: "Prices in USD before tax; tax is calculated at checkout for your location. Switching an existing Site license to a multi-year term? Email sales@mailviewer.app and we'll prorate it."
3. Give the pricing section id="pricing" (the release host's footers link to /mac#pricing).
4. The Download button points at https://updates.mailviewer.app/latest/Mailviewer.pkg and the version text reads from https://updates.mailviewer.app/latest.json at build time or shows "1.0.0" if that's static here; say which.
5. Navigation: a "Mac app" tab in the site header on every page (home, viewer, /mac, terms, privacy), and a card on the home page below the viewer's intro: "Mailviewer for Mac: the same viewer as a native app, with Quick Look, mailboxes and MDM deployment. Download free, license for teams." linking to /mac.
6. One design language. The Mac pages (updates.mailviewer.app and /mac) carry the newer dark system: --bg #0B1211, --card #131D1B, --ink #ECF2F0, --ink2 #A7B5B1, --ink3 #788683, accent #3FD0B3, the lit gradient buttons, the header and footer. Bring the home page, terms and privacy pages to that system so the site reads as one product. Leave the viewer tool itself functionally and structurally as it is (the review rated it the strongest page); give it the same tokens for background, text, accent and buttons so it no longer looks like a different company, and nothing more. A deeper viewer restyle is a separate ticket.
7. Per-route document titles ("Mailviewer", "Mailviewer for Mac", "Terms", "Privacy"), Terms and Contact as pages rather than mailto links (Contact shows the support address with a copy button, like the app's sheet), and no empty cells in the home page grids.

Implement MAC-787 in the web repo (mailviewer.app), in a worktree from origin/main. Read CLAUDE.md, the ticket, PR #20's purchase page and PR #22's review first; if #20 is still open, base on its branch and say so. Everything in the ticket; tests as the repo does them; laws-of-ux-checklist on /mac and home; release:preview to staging; post the staging URL; open the PR; idle. No promote.
