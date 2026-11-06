import { describe, expect, it } from "vitest";
import html from "../../public/mac/index.html?raw";
import { MAC_APP_VERSION, MAC_DOWNLOAD_URL, MAC_PURCHASE_LINKS, SITE_TERMS } from "../lib/mac-purchase-links";
import { MAC_PLANS, NBSP, overageLine, perMacLine, siteBreakEvenLine, usd } from "../lib/mac-pricing";
/** A derived line as the page writes it: U+00A0 as the entity, so an editor can see it. */
const onPage = (line: string) => line.replaceAll(NBSP, "&nbsp;");

/**
 * MAC-715, MAC-787: the Mac purchase page, public/mac/index.html, served at /mac.
 *
 * The page is the design of record (~/Downloads/mac-index.html, 17 October),
 * ported byte for byte apart from --ink3, which is #788683 rather than #6F7D7A
 * so that it passes AA (David, 17 October; the canvas has it too), David's
 * decisions of 17 October (the Personal button is a disabled "Coming to the
 * Mac App Store", the requirements line names macOS 13, the logo links to /),
 * and MAC-787 (5 November): the Site license sold by term, the Download button
 * and version, the tax line under the cards, Terms and Contact as pages, the
 * "Mac app" tab, and grids whose column counts divide their cards; and
 * MAC-791 (6 November): Personal at $4.99 a year, and under each price what
 * it comes to per Mac, computed from src/lib/mac-pricing.ts.
 *
 * It is static under the site's CSP: no script, nothing from another origin.
 * Team, Business and Site license buy through Stripe Payment Links, recorded
 * in src/lib/mac-purchase-links.ts.
 *
 * The real-browser half (the CSP, every link against dist/, the term picker
 * by mouse and keyboard) is tests/print/mac-page.test.mjs.
 */
const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const markup = html.slice(html.indexOf("</style>"));
/** A plan card's markup, from its heading to the next card (or, for the last card, to the end of the grid). */
const card = (name: string) => {
  const start = html.indexOf(`<h3>${name}</h3>`);
  expect(start, name).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="plan', start);
  return html.slice(start, next === -1 ? html.indexOf("</fieldset>", start) : next);
};
const site = card("Site license");
const siteLinks = { ...MAC_PURCHASE_LINKS.site };

describe("the Mac purchase page", () => {
  it("runs no script and no inline handler", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  it("loads nothing from another origin", () => {
    expect(html).not.toMatch(/\ssrc\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/@import/i);
    for (const link of html.matchAll(/<link[^>]*>/gi)) expect(link[0]).toMatch(/href="\/[^/]/);
    expect(html).not.toMatch(/<(iframe|object|embed|form)\b/i);
  });

  it("buys Team, Business and Site license through the Payment Links in mac-purchase-links.ts", () => {
    const stripe = hrefs.filter((h) => /stripe/i.test(h));
    expect(stripe).toEqual([MAC_PURCHASE_LINKS.team, MAC_PURCHASE_LINKS.business, siteLinks[1], siteLinks[2], siteLinks[3]]);
    expect(card("Team")).toContain(`<a href="${MAC_PURCHASE_LINKS.team}" class="btn btn-primary">Buy Team</a>`);
    expect(card("Business")).toContain(`<a href="${MAC_PURCHASE_LINKS.business}" class="btn btn-primary">Buy Business</a>`);
    for (const { years } of SITE_TERMS) {
      expect(site).toContain(`<a href="${siteLinks[years]}" class="btn btn-light t${years}">Buy Site license</a>`);
    }
    for (const url of [MAC_PURCHASE_LINKS.team, MAC_PURCHASE_LINKS.business, ...Object.values(siteLinks)]) {
      expect(url).toMatch(/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/);
    }
    expect(new Set(Object.values(siteLinks)).size, "three different links").toBe(3);
    expect(card("Personal")).not.toMatch(/stripe/i);
  });

  describe("the Site license term (MAC-787)", () => {
    it("is three radios in a named group, 1 year checked, each with a visible label", () => {
      expect(site).toContain('<fieldset class="term">\n<legend>License term</legend>');
      const radios = [...site.matchAll(/<input type="radio" name="site-term" id="site-(\d)y" value="(\d)"( checked)?>/g)];
      expect(radios.map((r) => [r[1], r[2], !!r[3]])).toEqual([["1", "1", true], ["2", "2", false], ["3", "3", false]]);
      expect(site).toContain('<label for="site-1y">1 year</label>');
      expect(site).toContain('<label for="site-2y">2 years</label>');
      expect(site).toContain('<label for="site-3y">3 years</label>');
      expect(site.match(/<input /g)).toHaveLength(3);
    });

    it("shows the per-year price for each term, and what is billed", () => {
      for (const { years, perYear, total } of SITE_TERMS) {
        expect(site).toContain(`<div class="t${years}"><span class="price">${perYear}</span>`);
        expect(site).toContain(`<p class="term-total">${total}</p>`);
      }
      // "/ year" on every term, as on the Team and Business cards; the sub-line says what is billed.
      for (const { perYear } of SITE_TERMS) expect(site).toContain(`${perYear}</span><span style="color: #AFC0D6"> / year</span>`);
      expect(site).not.toContain("per year");
      expect(site).not.toContain("From $");
    });

    it("needs no script: the radios precede the prices and buttons they show, and the CSS does the switching", () => {
      const at = (s: string) => {
        const i = site.indexOf(s);
        expect(i, s).toBeGreaterThan(-1);
        return i;
      };
      const lastRadio = at('id="site-3y"');
      expect(lastRadio).toBeLessThan(at('<div class="seg">'));
      expect(at('<div class="seg">')).toBeLessThan(at('<div class="t1">'));
      expect(at('<div class="t3">')).toBeLessThan(at('<ul class="feats site-feats">'));
      expect(at('<ul class="feats site-feats">')).toBeLessThan(at('class="btn btn-light t1"'));
      for (const years of [1, 2, 3]) {
        expect(style).toContain(`#site-${years}y:checked~div.t${years}`);
        expect(style).toContain(`#site-${years}y:checked~a.t${years}`);
        expect(style).toContain(`#site-${years}y:checked~.seg label[for="site-${years}y"]`);
        expect(style).toContain(`#site-${years}y:focus-visible~.seg label[for="site-${years}y"]`);
      }
      expect(style).toContain(".term .t1,.term .t2,.term .t3{display:none}");
      // Without CSS every term shows and the first Buy link is the 1-year one.
      expect(hrefs.filter((h) => Object.values(siteLinks).includes(h as never))[0]).toBe(siteLinks[1]);
      // The hidden radios stay focusable: hidden by clipping, not display:none.
      expect(style).toMatch(/\.term legend,\.term input\{position:absolute;width:1px;height:1px/);
      expect(style).not.toMatch(/\.term input\{[^}]*display:none/);
    });
  });

  describe("the prices and the lines under them, from mac-pricing.ts (MAC-791)", () => {
    const { personal, team, business, site: sitePlan } = MAC_PLANS;

    it("sells Personal at $4.99 a year, the App Store subscription, not one-time", () => {
      expect(card("Personal")).toContain(`<p class="price-block"><span class="price">${usd(personal.price)}</span><span class="muted"> / year</span></p>`);
      expect(usd(personal.price)).toBe("$4.99");
      expect(html).not.toMatch(/one[- ]time/i);
    });

    it.each([
      ["Team", team],
      ["Business", business],
    ])("%s: the price, then what it comes to a Mac a month, in one paragraph", (name, plan) => {
      const c = card(name);
      expect(c).toContain(
        `<p class="price-block"><span class="price">${usd(plan.price)}</span><span class="muted"> / year</span>\n<span class="per-mac">${onPage(perMacLine(plan))}</span></p>`,
      );
      // Written as entities, never as a raw U+00A0 an editor cannot see.
      expect(c).not.toContain(NBSP);
      expect(onPage(perMacLine(plan)).match(/&nbsp;/g)).toHaveLength(5);
      expect(c).toContain(`<p class="muted plan-sub">${overageLine(plan)}</p>`);
      expect(c.match(/class="per-mac/g)).toHaveLength(1);
    });

    it("Site license: the break-even against Business, once, after the term block and before the features, whichever term shows", () => {
      expect(site).toContain(`</div>\n<p class="per-mac site-per-mac">${siteBreakEvenLine()}</p>\n<ul class="feats site-feats">`);
      expect(site.match(/class="per-mac/g)).toHaveLength(1);
      // Inside no term block: it does not change with the segmented control.
      for (const years of [1, 2, 3]) expect(site.slice(site.indexOf(`<div class="t${years}">`), site.indexOf("</div>", site.indexOf(`<div class="t${years}">`)))).not.toContain("per-mac");
      expect(SITE_TERMS.find((t) => t.years === 1)?.perYear).toBe(usd(sitePlan.price));
    });

    it("says the three lines the ticket asks for, and nothing per device", () => {
      expect(perMacLine(team).replaceAll(NBSP, " ")).toBe("Works out to about $1 a Mac a month");
      expect(perMacLine(business).replaceAll(NBSP, " ")).toBe("Works out to about 83¢ a Mac a month");
      expect(siteBreakEvenLine()).toBe("Costs less than Business from about 650 Macs");
      expect(markup).not.toMatch(/per device|\/ device|per Mac\b|\/ Mac\b/i);
      expect(markup).not.toContain("a Mac per month");
    });

    it("styles the line as a block under the price, in the card's muted ink", () => {
      expect(style).toContain(".price-block{margin:0}");
      expect(style).toMatch(/\.per-mac\{display:block;margin-top:6px;font-size:14px;line-height:1\.45;[^}]*color:var\(--ink2\)\}/);
      expect(style).toContain(".site-per-mac{margin:-8px 0 0;color:#AFC0D6}");
      // The description and the FAQ carry no price, so there is nothing there to go stale.
      expect(html.match(/<meta name="description" content="([^"]*)"/)?.[1]).not.toMatch(/\$|one-time|year/);
      expect(html).not.toContain("application/ld+json");
    });
  });

  it("says, under the cards, that prices are before tax and that a term switch is prorated", () => {
    const plansEnd = html.indexOf("</fieldset>");
    const after = html.slice(plansEnd, html.indexOf('<div class="card"', plansEnd));
    expect(after).toContain(
      "Prices in USD before tax; tax is calculated at checkout for your location. Switching an existing Site license to a multi-year term? Email <a href=\"mailto:sales@mailviewer.app\">sales@mailviewer.app</a> and we'll prorate it.",
    );
    expect(markup).not.toContain("Sales tax or VAT is calculated");
  });

  it("has the pricing section at #pricing, where the header's Buy and the hero's See plans go", () => {
    expect(markup).toContain('<section id="pricing"');
    expect(markup).toContain('<a href="#pricing" class="btn btn-primary btn-sm">Buy</a>');
    expect(markup).toContain('<a href="#pricing" class="btn btn-secondary">See plans</a>');
  });

  it("downloads the installer from the release host's /latest/ URL and names the version, by hand", () => {
    expect(markup).toMatch(new RegExp(`<a href="${MAC_DOWNLOAD_URL}" class="btn btn-primary">(<svg[^]*?</svg>)?Download for Mac</a>`));
    expect(markup).toContain(`Version ${MAC_APP_VERSION}, free to download.`);
    // The version is static, and the page says so where the next person will look.
    expect(markup).toMatch(/<!--[^]*?not read from https:\/\/updates\.mailviewer\.app\/latest\.json[^]*?MAC_APP_VERSION[^]*?-->/);
    expect(MAC_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("links only to anchors on the page, https URLs, email and the site's own paths", () => {
    for (const href of hrefs) {
      if (href.startsWith("#")) expect(ids, href).toContain(href.slice(1));
      else if (href.startsWith("/")) expect(href).toMatch(/^\/(?!\/)/);
      else expect(href).toMatch(/^(https:\/\/[a-z0-9.-]+\/|mailto:[a-z]+@mailviewer\.app$)/);
    }
  });

  it("offers Personal as a disabled 'Coming to the Mac App Store', with nowhere to go", () => {
    expect(card("Personal")).toContain('<a class="btn btn-secondary" aria-disabled="true" tabindex="-1">Coming to the Mac App Store</a>');
    expect(card("Personal")).not.toMatch(/href=/);
  });

  it("names what it runs on, with no placeholder left", () => {
    expect(markup).toContain("Requires macOS 13 or later · Apple silicon and Intel · Signed and notarized by Machinery Software LLC");
    expect(markup).not.toMatch(/\[[A-Z0-9 .-]+\]/);
  });

  it("links the logo to the web app's home", () => {
    expect(markup).toMatch(/<a href="\/" style="display: flex;[^>]*>\s*<svg/);
    expect(hrefs).not.toContain("#");
  });

  it("has the 'Mac app' tab, current, in a header shared with the web app", () => {
    expect(markup).toContain('<a href="/mac" style="color: var(--ink); font-weight: 600" aria-current="page">Mac app</a>');
    expect(markup).toContain('<a href="/" class="muted" style="color: var(--ink2)">Web app</a>');
  });

  it("links Terms to the Mac terms on the release host and Contact to the site's page, not to mail", () => {
    // One terms text, published with the app's downloads (David, 6 November); the site's #/terms carries the web app's own.
    expect(markup).toContain('<a href="https://updates.mailviewer.app/terms/" style="color: var(--ink2)">Terms</a>');
    expect(hrefs).not.toContain("/#/terms");
    expect(markup).toContain('<a href="/#/contact" style="color: var(--ink2)">Contact</a>');
    expect(hrefs).not.toContain("/mac/terms");
    expect(hrefs.filter((h) => h.startsWith("mailto:"))).toEqual(["mailto:sales@mailviewer.app"]);
  });

  it("lays out plans, features and questions in four columns, two, then one: no row ends in an empty tile", () => {
    expect(style).toContain(".plans{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))");
    expect(style).toContain(".grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))");
    expect(style).toContain("@media (max-width: 1000px){.plans,.grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}");
    expect(style).toContain("@media (max-width: 560px){.plans,.grid4{grid-template-columns:minmax(0,1fr)}}");
    expect(style).toContain(".grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(markup, "no auto-fit grid, whose column count depends on the width").not.toContain("auto-fit");
    expect(markup.match(/class="(card )?grid2"/g)).toHaveLength(2);
    expect(markup.match(/<div class="plan[ "]/g)).toHaveLength(4);
    for (const grid of markup.split('<div class="grid4">').slice(1)) {
      const inner = grid.slice(0, grid.indexOf("\n</div>\n</div>"));
      expect((inner.match(/<div class="feature">/g) ?? []).length).toBe(4);
    }
  });

  it("keeps its headings in order", () => {
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    levels.forEach((l, i) => i && expect(l - levels[i - 1], `h${levels[i - 1]} then h${l}`).toBeLessThanOrEqual(1));
  });
});

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the Mac purchase page's contrast (WCAG AA, 4.5:1 for normal text)", () => {
  const vars = Object.fromEntries(
    [...style.slice(style.indexOf(".mv{")).matchAll(/--([a-z0-9]+):(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]),
  );

  it("reads its palette from the page's CSS variables", () => {
    expect(vars).toMatchObject({ bg: "#0B1211", card: "#131D1B", card2: "#172320", ink: "#ECF2F0", ink2: "#A7B5B1", ink3: "#788683" });
  });

  it("passes AA with --ink, --ink2 and --ink3 on both backgrounds", () => {
    for (const bg of [vars.bg, vars.card]) {
      for (const ink of [vars.ink, vars.ink2, vars.ink3]) expect(contrast(ink, bg), `${ink} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(vars.ink, vars.bg).toFixed(2)).toBe("16.71");
    expect(contrast(vars.ink, vars.card).toFixed(2)).toBe("15.19");
    expect(contrast(vars.ink2, vars.bg).toFixed(2)).toBe("8.92");
    expect(contrast(vars.ink2, vars.card).toFixed(2)).toBe("8.11");
    expect(contrast(vars.ink3, vars.bg).toFixed(2)).toBe("4.99");
    expect(contrast(vars.ink3, vars.card).toFixed(2)).toBe("4.54");
  });

  it("passes AA with the per-Mac line's ink on the whole card gradient, and the Site card's (MAC-791)", () => {
    // --ink3 would not: 4.27:1 on --card2, the top of the gradient, where the price sits.
    expect(contrast(vars.ink2, vars.card2).toFixed(2)).toBe("7.62");
    expect(contrast(vars.ink3, vars.card2)).toBeLessThan(4.5);
    for (const bg of ["#1A2A3E", "#121D2B"]) expect(contrast("#AFC0D6", bg)).toBeGreaterThanOrEqual(4.5);
  });
});
