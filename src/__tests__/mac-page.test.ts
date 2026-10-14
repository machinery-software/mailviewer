import { describe, expect, it } from "vitest";
import html from "../../public/mac/index.html?raw";

/**
 * MAC-715: the Mac purchase page, public/mac/index.html, served at /mac.
 *
 * It is a static page under the site's CSP. It runs no script and loads
 * nothing from another origin, its links all go somewhere real, and until
 * automated checkout issues a key (MAC-651) no button can take money: the
 * Team and Business buttons are emails to sales, Personal has no button.
 */
const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const card = (name: string) => {
  const start = html.indexOf(`>${name}</h3>`);
  return html.slice(start, html.indexOf("</h3>", html.indexOf("<h3", start + 1)));
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

  it("has no placeholder left from the design", () => {
    expect(html).not.toMatch(/\[[A-Z][A-Z -]+\]/);
    expect(hrefs).not.toContain("#");
    expect(html).not.toMatch(/\.dc\.html/);
  });

  it("links only to anchors on the page, the site's own routes, the release host, GitHub and email", () => {
    for (const href of hrefs) {
      if (href.startsWith("#")) expect(ids, href).toContain(href.slice(1));
      else if (href.startsWith("/")) expect(["/", "/mac", "/#/privacy", "/favicon.svg"], href).toContain(href);
      else expect(href).toMatch(/^(https:\/\/updates\.mailviewer\.app\/|https:\/\/github\.com\/machinery-software\/mailviewer\/|mailto:(sales|support)@mailviewer\.app)/);
    }
  });

  it("follows the launch rules for the buttons: no checkout until keys are issued automatically", () => {
    expect(html).not.toMatch(/stripe|checkout|apps\.apple\.com/i);
    expect(card("Personal")).toContain("Coming to the Mac App Store");
    expect(card("Personal")).not.toMatch(/<a\b/);
    for (const plan of ["Team", "Business"]) {
      expect(card(plan)).toMatch(/href="mailto:sales@mailviewer\.app\?subject=[^"]+"[^>]*>Email sales@mailviewer\.app to buy</);
    }
    expect(card("Site license")).toMatch(/href="mailto:sales@mailviewer\.app[^"]*"[^>]*>Talk to us</);
  });

  it("shows the prices and the one-key-per-organization model", () => {
    for (const price of ["$4.99", "$299", "$12", "$999", "$9", "From $6,000"]) expect(html).toContain(price);
    expect(html).not.toMatch(/key per Mac|spare keys/i);
    expect(html).toContain("One license key for your organization");
  });

  it("makes no claim the Mac app does not keep", () => {
    // The app makes no network connections at all (MailboxConstraintTests in
    // the Mac repository), so there is no update check to turn off.
    expect(html).not.toMatch(/update check/i);
    // Not until MAC-515 has verified the zone injects nothing.
    expect(html).not.toMatch(/no track/i);
  });

  it("keeps its headings in order", () => {
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    levels.forEach((l, i) => i && expect(l - levels[i - 1], `h${levels[i - 1]} then h${l}`).toBeLessThanOrEqual(1));
  });
});
