/**
 * The Stripe Payment Links behind the Buy buttons on the Mac purchase page,
 * public/mac/index.html (MAC-715), by tier.
 *
 * The page is static, with no script and no build step of its own, so the
 * links are written into its markup. This is the one place they are recorded:
 * src/__tests__/mac-page.test.ts fails if the page's buy.stripe.com links and
 * these differ. Change a link here and on the page together.
 *
 * Personal has no Payment Link: it is sold through the Mac App Store.
 */
export const MAC_PURCHASE_LINKS = {
  team: "https://buy.stripe.com/6oU4gBfL28581BXe4a3Nm07",
  business: "https://buy.stripe.com/9B68wR8iA5X02G1bW23Nm08",
  site: "https://buy.stripe.com/eVqcN71Uc1GK94p3pw3Nm09",
} as const;
