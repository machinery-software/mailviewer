import { describe, expect, it } from "vitest";
import { SITE_TERMS } from "../lib/mac-purchase-links";
import { MAC_PLANS, aboutMoney, breakEvenMacs, overageLine, perMacAMonth, perMacLine, siteBreakEvenLine, usd } from "../lib/mac-pricing";

/**
 * MAC-791: the lines under the plan prices are computed from the plan data,
 * never typed. These are the three the ticket specifies, and the rules they
 * follow; src/__tests__/mac-page.test.ts holds the page to the same values.
 */
describe("the Mac plans' prices", () => {
  it("are the ones the page sells at", () => {
    expect(MAC_PLANS).toEqual({
      personal: { name: "Personal", price: 4.99 },
      team: { name: "Team", price: 299, includedMacs: 25, overagePerMac: 12 },
      business: { name: "Business", price: 999, includedMacs: 100, overagePerMac: 9 },
      site: { name: "Site license", price: 6000 },
    });
  });

  it("print as the page does: cents only when there are any, thousands separated", () => {
    expect(usd(MAC_PLANS.personal.price)).toBe("$4.99");
    expect(usd(MAC_PLANS.team.price)).toBe("$299");
    expect(usd(MAC_PLANS.business.price)).toBe("$999");
    expect(usd(MAC_PLANS.site.price)).toBe("$6,000");
    expect(usd(12)).toBe("$12");
    expect(usd(9)).toBe("$9");
    expect(usd(0.5)).toBe("$0.50");
  });

  it("agree with the Site license's 1-year term in mac-purchase-links.ts", () => {
    const oneYear = SITE_TERMS.find((t) => t.years === 1)!;
    expect(oneYear.perYear).toBe(usd(MAC_PLANS.site.price));
    expect(oneYear.total).toBe(`${usd(MAC_PLANS.site.price)} billed yearly`);
  });
});

describe("the per-Mac lines (MAC-791)", () => {
  it("Team: $299 over 25 Macs over twelve months is about $1 a Mac a month", () => {
    expect(perMacAMonth(MAC_PLANS.team)).toBeCloseTo(11.96 / 12, 4);
    expect(perMacLine(MAC_PLANS.team)).toBe("Works out to about $1 a Mac a month");
  });

  it("Business: $999 over 100 Macs over twelve months is about 83¢ a Mac a month", () => {
    expect(perMacAMonth(MAC_PLANS.business)).toBeCloseTo(9.99 / 12, 4);
    expect(perMacLine(MAC_PLANS.business)).toBe("Works out to about 83¢ a Mac a month");
  });

  it("Site: Business with its overage reaches the 1-year Site price at about 650 Macs", () => {
    // $999 + $9 × (650 − 100) = $5,949; the exact crossing is 655.67, rounded to the nearest 50.
    const { business, site } = MAC_PLANS;
    expect(business.includedMacs + (site.price - business.price) / business.overagePerMac).toBeCloseTo(655.67, 2);
    expect(breakEvenMacs(business)).toBe(650);
    expect(siteBreakEvenLine()).toBe("Costs less than Business from about 650 Macs");
  });

  it("rounds to the nearest 50 either way, and compares with the 1-year Site price whatever term is shown", () => {
    expect(breakEvenMacs(MAC_PLANS.business, 5949)).toBe(650);
    expect(breakEvenMacs(MAC_PLANS.business, 6300)).toBe(700);
    expect(breakEvenMacs(MAC_PLANS.business, 6200)).toBe(700);
    expect(breakEvenMacs(MAC_PLANS.team)).toBe(500);
    // The 2- and 3-year per-year prices are lower; the line does not move with the segmented control.
    for (const term of SITE_TERMS) expect(siteBreakEvenLine()).not.toContain(String(breakEvenMacs(MAC_PLANS.business, term.years * 1000)));
  });

  it("say the overage the way the cards do", () => {
    expect(overageLine(MAC_PLANS.team)).toBe("Up to 25 Macs, then $12 a Mac.");
    expect(overageLine(MAC_PLANS.business)).toBe("Up to 100 Macs, then $9 a Mac.");
  });
});

describe("the wording rules (MAC-791)", () => {
  it("round to whole dollars from a dollar up and to cents below", () => {
    expect(aboutMoney(0.9967)).toBe("$1");
    expect(aboutMoney(0.995)).toBe("$1");
    expect(aboutMoney(0.994)).toBe("99¢");
    expect(aboutMoney(0.8325)).toBe("83¢");
    expect(aboutMoney(0.005)).toBe("1¢");
    expect(aboutMoney(1.49)).toBe("$1");
    expect(aboutMoney(1.5)).toBe("$2");
    expect(aboutMoney(12.3)).toBe("$12");
  });

  it("put 'about' before every figure, 'Works out to' before a per-Mac figure, say 'a Mac a month', and never 'per device' or '/ device'", () => {
    for (const line of [perMacLine(MAC_PLANS.team), perMacLine(MAC_PLANS.business), siteBreakEvenLine()]) {
      expect(line).toMatch(/about (\$\d+|\d+¢|\d+ Macs)/);
      expect(line).not.toMatch(/device/i);
      expect(line).not.toMatch(/per Mac|\/ Mac|per month|\/ month/i);
    }
    for (const plan of [MAC_PLANS.team, MAC_PLANS.business]) expect(perMacLine(plan)).toMatch(/^Works out to about (\$\d+|\d+¢) a Mac a month$/);
    expect(siteBreakEvenLine()).not.toMatch(/^Works out to/);
  });
});
