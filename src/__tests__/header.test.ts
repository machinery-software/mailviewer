// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import { Footer } from "../ui/Footer";

/**
 * MAC-715, MAC-787: the site's header carries a "Mac app" tab to the Mac
 * purchase page at /mac on every route, and the footer has the links the Mac
 * pages' footers have: pages, not mailto links.
 */
describe("the site header", () => {
  const page = renderToStaticMarkup(createElement(App));
  const nav = page.slice(page.indexOf('<nav class="nav"'), page.indexOf("</nav>"));

  it("links to the Mac app at /mac, styled like the other header links", () => {
    expect(nav).toContain('<a class="nav-link" href="/mac">Mac app</a>');
  });

  it("names the product the way the Mac pages do, with the same mark", () => {
    expect(page).toMatch(/<a class="brand" href="#\/"><svg[^]*?<\/svg>Mailviewer<\/a>/);
    expect(page).toContain('<linearGradient id="mv-logo-gradient"');
  });

  it("keeps the tabs in order: Open a file, Mac app, Privacy, Verify, Source, Report a problem", () => {
    const labels = [...nav.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Open a file", "Mac app", "Privacy", "Verify", "Source", "Report a problem"]);
  });
});

describe("the site footer", () => {
  const footer = renderToStaticMarkup(createElement(Footer, { note: "A note." }));

  it("links Privacy, Terms, Security, Mac app, Contact and Source, and nothing by mailto", () => {
    const links = [...footer.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2].trim(), m[1]]);
    expect(links).toEqual([
      ["Machinery Software LLC", "https://machinery.software"],
      ["Privacy", "#/privacy"],
      ["Terms", "#/terms"],
      ["Security", "https://github.com/machinery-software/mailviewer/security"],
      ["Mac app", "/mac"],
      ["Contact", "#/contact"],
      ["Source", "https://github.com/machinery-software/mailviewer"],
    ]);
    expect(footer).not.toContain("mailto:");
  });

  it("carries the page's note and the company line", () => {
    expect(footer).toContain('<span class="footer-note">A note.</span>');
    expect(footer).toContain("© 2026 ");
  });
});
