/**
 * The Stripe Payment Links behind the Buy buttons on the Mac purchase page,
 * public/mac/index.html (MAC-715, MAC-787), by tier, and the Site license's
 * links by term.
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
  /** The Site license, by term in years. 1 year is the default: the link a browser without CSS meets first. */
  site: {
    1: "https://buy.stripe.com/eVqcN71Uc1GK94p3pw3Nm09",
    2: "https://buy.stripe.com/14AeVfeGYetweoJf8e3Nm0a",
    3: "https://buy.stripe.com/4gM6oJgP6dpsa8tf8e3Nm0b",
  },
} as const;

/** The Site license by term: the per-year price, and what the page says is billed. */
export const SITE_TERMS = [
  { years: 1, perYear: "$6,000", total: "$6,000 billed yearly" },
  { years: 2, perYear: "$5,700", total: "$11,400 billed once for 2 years" },
  { years: 3, perYear: "$5,400", total: "$16,200 billed once for 3 years" },
] as const;

/**
 * The Download button on the purchase page. The release host's /latest/
 * redirect always points at the current installer.
 */
export const MAC_DOWNLOAD_URL = "https://updates.mailviewer.app/latest/Mailviewer.pkg";

/**
 * The version the purchase page names next to the Download button.
 *
 * Written by hand, not read from https://updates.mailviewer.app/latest.json:
 * public/ is copied into the build untouched, and the build never reaches the
 * network (DEPLOYMENT.md §5, build reproducibility). Change it here and on the
 * page with each Mac release; the unit test holds the two equal.
 */
export const MAC_APP_VERSION = "1.0.0";
