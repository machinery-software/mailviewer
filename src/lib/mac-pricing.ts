/**
 * The Mac app's plans, their prices and what each covers: the one place these
 * numbers are recorded (MAC-791). Everything the purchase page says about
 * money is either one of these or computed from them below.
 *
 * The purchase page, public/mac/index.html, is static, with no script and no
 * build step of its own, so the numbers are written into its markup, as the
 * Stripe links are (mac-purchase-links.ts). The binding is the test:
 * src/__tests__/mac-page.test.ts fails if the page's prices, included Macs,
 * overage rates, or any of the derived lines differ from what these compute.
 * Change a number here and on the page together; change it here alone and CI
 * says which line on the page went stale.
 *
 * Prices are a year's, in US dollars. Personal is sold by Apple through the
 * Mac App Store as a yearly subscription (MAC-745, 24 October): $4.99 a year,
 * not one-time. Team and Business include a number of Macs and price growth
 * at a flat rate per Mac beyond it; the Site license covers every Mac. Its
 * multi-year terms are SITE_TERMS in mac-purchase-links.ts; the 1-year price
 * here is the one those start from.
 */
export const MAC_PLANS = {
  personal: { name: "Personal", price: 4.99 },
  team: { name: "Team", price: 299, includedMacs: 25, overagePerMac: 12 },
  business: { name: "Business", price: 999, includedMacs: 100, overagePerMac: 9 },
  site: { name: "Site license", price: 6000 },
} as const;

type Metered = typeof MAC_PLANS.team | typeof MAC_PLANS.business;

/** A dollar amount as the page prints it: whole dollars with thousands separators, cents only when there are any. */
export function usd(amount: number): string {
  const cents = Math.round(amount * 100);
  const whole = Math.trunc(cents / 100).toLocaleString("en-US");
  const rest = cents % 100;
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

/**
 * A small amount of money, the way the page says it after "about": whole
 * dollars from a dollar up, cents below. $0.9967 is "$1"; $0.8325 is "83¢".
 */
export function aboutMoney(amount: number): string {
  const cents = Math.round(amount * 100);
  return cents >= 100 ? `$${Math.round(amount)}` : `${cents}¢`;
}

/** What one of a plan's included Macs costs a month: the yearly price over the included Macs over twelve. */
export function perMacAMonth(plan: Metered): number {
  return plan.price / plan.includedMacs / 12;
}

/** The line under a Team or Business price. "about" always comes before the figure. */
export function perMacLine(plan: Metered): string {
  return `about ${aboutMoney(perMacAMonth(plan))} a Mac a month`;
}

/** The line under a Team or Business name: what is included, and the rate past it. */
export function overageLine(plan: Metered): string {
  return `Up to ${plan.includedMacs} Macs, then ${usd(plan.overagePerMac)} a Mac.`;
}

/**
 * The number of Macs at which a metered plan, with its overage, costs what
 * the Site license costs for a year:
 *
 *   plan.price + plan.overagePerMac × (n − plan.includedMacs) = site.price
 *
 * solved for n and rounded to the nearest 50. It is "about": the page's
 * reader is sizing a fleet, not auditing one.
 */
export function breakEvenMacs(plan: Metered, sitePrice: number = MAC_PLANS.site.price): number {
  const exact = plan.includedMacs + (sitePrice - plan.price) / plan.overagePerMac;
  return Math.round(exact / 50) * 50;
}

/** The line under the Site license's price, the same whichever term is shown: the 1-year price is the comparison. */
export function siteBreakEvenLine(): string {
  const business = MAC_PLANS.business;
  return `Costs less than ${business.name} from about ${breakEvenMacs(business)} Macs`;
}
