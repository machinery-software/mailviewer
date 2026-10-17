import { describe, expect, it } from "vitest";
import html from "../../public/mac/index.html?raw";
import { MAC_PURCHASE_LINKS } from "../lib/mac-purchase-links";

/**
 * MAC-715: the Mac purchase page, public/mac/index.html, served at /mac.
 *
 * The page is the design of record (~/Downloads/mac-index.html, 17 October),
 * ported byte for byte apart from the Terms link, which is an email until a
 * terms page exists (MAC-740). It is static under the site's CSP: no script, nothing
 * from another origin. Team, Business and Site license buy through Stripe
 * Payment Links, recorded in src/lib/mac-purchase-links.ts.
 *
 * The real-browser half (the CSP, every link against dist/, the size of the
 * --ink3 text) is tests/print/mac-page.test.mjs.
 */
const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const markup = html.slice(html.indexOf("</style>"));
/** A plan card's markup, from its heading to the next card. */
const card = (name: string) => {
  const start = html.indexOf(`<h3>${name}</h3>`);
  expect(start, name).toBeGreaterThan(-1);
  const next = html.indexOf('<div class="plan', start);
  return html.slice(start, next === -1 ? html.indexOf("</div>\n</div>", start) : next);
};

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
    expect(stripe).toEqual([MAC_PURCHASE_LINKS.team, MAC_PURCHASE_LINKS.business, MAC_PURCHASE_LINKS.site]);
    expect(card("Team")).toContain(`<a href="${MAC_PURCHASE_LINKS.team}" class="btn btn-primary">Buy Team</a>`);
    expect(card("Business")).toContain(`<a href="${MAC_PURCHASE_LINKS.business}" class="btn btn-primary">Buy Business</a>`);
    expect(card("Site license")).toContain(`<a href="${MAC_PURCHASE_LINKS.site}" class="btn btn-light">Buy Site license</a>`);
    for (const url of Object.values(MAC_PURCHASE_LINKS)) expect(url).toMatch(/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/);
    expect(card("Personal")).not.toMatch(/stripe/i);
  });

  it("links only to anchors on the page, https URLs, email and the site's own paths", () => {
    for (const href of hrefs) {
      // "#" is the top of the page (the design's logo and Personal button).
      if (href.startsWith("#")) href === "#" || expect(ids, href).toContain(href.slice(1));
      else if (href.startsWith("/")) expect(href).toMatch(/^\/(?!\/)/);
      else expect(href).toMatch(/^(https:\/\/[a-z0-9.-]+\/|mailto:[a-z]+@mailviewer\.app$)/);
    }
  });

  it("links Terms to support by email until a terms page exists", () => {
    expect(hrefs).not.toContain("/mac/terms");
    expect(markup).toContain('<a href="mailto:support@mailviewer.app" style="color: var(--ink2)">Terms</a>');
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
    expect(vars).toMatchObject({ bg: "#0B1211", card: "#131D1B", ink: "#ECF2F0", ink2: "#A7B5B1", ink3: "#6F7D7A" });
  });

  it("passes AA with --ink and --ink2 on both backgrounds", () => {
    for (const bg of [vars.bg, vars.card]) {
      expect(contrast(vars.ink, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars.ink2, bg)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(vars.ink, vars.bg).toFixed(2)).toBe("16.71");
    expect(contrast(vars.ink, vars.card).toFixed(2)).toBe("15.19");
    expect(contrast(vars.ink2, vars.bg).toFixed(2)).toBe("8.92");
    expect(contrast(vars.ink2, vars.card).toFixed(2)).toBe("8.11");
  });

  it("knows --ink3 fails AA, so keeps it to the footer and fine print", () => {
    expect(contrast(vars.ink3, vars.bg).toFixed(2)).toBe("4.41");
    expect(contrast(vars.ink3, vars.card).toFixed(2)).toBe("4.01");
    // Used in exactly two places: the .faint class (fine print, at most 14px:
    // tests/print/mac-page.test.mjs measures it) and the footer.
    expect([...style.matchAll(/([^{}]+)\{[^}]*var\(--ink3\)/g)].map((m) => m[1].trim())).toEqual([".faint"]);
    const inline = [...markup.matchAll(/<([a-z]+)[^>]*style="[^"]*var\(--ink3\)[^"]*"/g)];
    expect(inline).toHaveLength(1);
    expect(markup.slice(markup.lastIndexOf("<footer", inline[0].index), inline[0].index)).toMatch(/^<footer[^]*$/);
    expect(markup.indexOf("</footer>")).toBeGreaterThan(inline[0].index!);
    expect(html.match(/#6F7D7A/gi)).toHaveLength(1);
  });
});
