# MAC-791 brief (6 November 2026)

Ticket MAC-791, follow-up to MAC-787, on the /mac/ page of mailviewer.app. Work on a branch from main; open a PR, do not merge or promote.

1. Bug first. The Personal card says "$4.99 one-time". Personal is $4.99 per year (MAC-745). Fix it at the source of the pricing data so the card renders "/ year" like the other plans. Check the terms link text and any JSON-LD / meta description for the same mistake.

2. Per-Mac lines. Under each plan's price, add one muted secondary line. The plan price stays the headline; the new line is smaller and lower contrast, but must still pass AA.
   - Team: derived from $299 and 25 included Macs → "about $1 a Mac a month" ($11.96 a Mac a year)
   - Business: derived from $999 and 100 included Macs → "about 83¢ a Mac a month" ($9.99 a Mac a year)
   - Site: no per-Mac figure. Show the break-even against Business with overage: price_business + overage_business × (n − included_business) = site_annual, solved for n and rounded to the nearest 50 → "Costs less than Business from about 650 Macs". Use the 1-year Site price for this regardless of which term the segmented control shows.
   Compute every number from the same pricing data the cards already use (prices, included Macs, overage rates). Nothing hand-typed. Add a unit test that fails if any of the three lines disagrees with the data, and show it failing on a deliberately wrong constant before the fix.

3. Copy. "a Mac a month" throughout, no "per device", no "/ device". Round to whole dollars when ≥ $1 and to cents below; "about" always precedes the figure.

4. Checks before the PR: light and dark; 390px wide; VoiceOver reads price then the secondary line, in that order, as one group per card; Laws of UX checklist on the pricing section, compare to the MAC-787 baseline (47/60) and report the score; run npm test.

5. PR body: before/after screenshots of the three cards in light mode, the test output, and a device-check list for David (Safari, dark mode, VoiceOver on the Team card).

Do not touch the multi-year segmented control, the Stripe links, or the terms link.
