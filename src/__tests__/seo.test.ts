import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import indexHtml from "../../index.html?raw";
import macHtml from "../../public/mac/index.html?raw";
import robots from "../../public/robots.txt?raw";
import wrangler from "../../wrangler.jsonc?raw";
import Landing from "../ui/Landing";
import { MAC_PLANS } from "../lib/mac-pricing";
import { MAC_PURCHASE_LINKS } from "../lib/mac-purchase-links";
import {
  HOME,
  MAC,
  NOT_FOUND,
  OG_IMAGE,
  ORIGIN,
  headTags,
  jsonLdScript,
  macAppJsonLd,
  sitemapXml,
  webAppJsonLd,
} from "../site/pages";
import { GUIDES, type Guide, PLACEHOLDER_GUIDE, guidePage, publishedGuides } from "../site/guides";
import { renderGuide, renderHome, renderNotFound } from "../site/render";

/**
 * The SEO pass: what search engines and link previews read on each static
 * page, held to the record in src/site/pages.ts. The real-server half (404s,
 * robots.txt's type, the sitemap's URLs answering 200) runs against
 * `wrangler dev` in tests/print/seo.test.mjs.
 */

/** Compare line by line, ignoring indentation: index.html is indented, the record is not. */
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
const head = (html: string) => lines(html.slice(html.indexOf("<head>"), html.indexOf("</head>")));

const FIXTURE_GUIDE: Guide = {
  slug: "open-an-msg-file",
  title: "Open an .msg file",
  description: "A fixture guide for the tests.",
  published: true,
  body: "<p>FIXTURE-GUIDE-BODY</p>",
  forIT: "<p>FIXTURE-FOR-IT</p>",
};

describe("the hand-written pages' heads", () => {
  it("/ carries the home page's title, description, canonical and Open Graph tags", () => {
    expect(head(indexHtml)).toContain(lines(headTags(HOME)));
  });

  it("/mac/ carries the Mac page's", () => {
    expect(head(macHtml)).toContain(lines(headTags(MAC)));
  });

  it("each has one title and one description", () => {
    for (const html of [indexHtml, macHtml]) {
      expect(html.match(/<title>/g)).toHaveLength(1);
      expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    }
  });

  it("points og:image at the image in public/, on this origin", () => {
    expect(OG_IMAGE).toBe(`${ORIGIN}/og.png`);
  });
});

describe("structured data", () => {
  it("/ describes the web app, free", () => {
    expect(lines(indexHtml)).toContain(lines(jsonLdScript(webAppJsonLd())));
    const app = webAppJsonLd();
    expect(app["@type"]).toBe("WebApplication");
    expect(app.offers).toEqual({ "@type": "Offer", price: "0", priceCurrency: "USD" });
  });

  it("/mac/ describes Mailviewer for Mac, priced from mac-pricing.ts", () => {
    expect(lines(macHtml)).toContain(lines(jsonLdScript(macAppJsonLd())));
    const app = macAppJsonLd();
    expect(app).toMatchObject({
      "@type": "SoftwareApplication",
      name: "Mailviewer for Mac",
      operatingSystem: "macOS",
      applicationCategory: "UtilitiesApplication",
    });
    expect(app.offers.map((o) => [o.name, Number(o.price), o.priceSpecification.billingDuration, o.url])).toEqual([
      [MAC_PLANS.team.name, MAC_PLANS.team.price, "P1Y", MAC_PURCHASE_LINKS.team],
      [MAC_PLANS.business.name, MAC_PLANS.business.price, "P1Y", MAC_PURCHASE_LINKS.business],
      [MAC_PLANS.site.name, MAC_PLANS.site.price, "P1Y", MAC_PURCHASE_LINKS.site[1]],
    ]);
  });

  it("offers only what the page sells: every plan with a purchase link, and no other", () => {
    const sold = Object.keys(MAC_PURCHASE_LINKS).map((k) => MAC_PLANS[k as keyof typeof MAC_PLANS].name);
    expect(macAppJsonLd().offers.map((o) => o.name)).toEqual(sold);
  });

  it("has no HowTo or FAQ markup anywhere", () => {
    for (const html of [indexHtml, macHtml, renderGuide(FIXTURE_GUIDE, "/x.css")]) {
      expect(html).not.toMatch(/"@type":\s*"(HowTo|FAQPage)"/);
    }
  });
});

describe("claims", () => {
  // TODO(PR #29, MAC-513): until #29 merges, .olm does not open in production,
  // and .pst/.ost have no fixture (MAC-526): no new text names them.
  it("names no .pst, .ost or .olm in any new text", () => {
    const fresh = [
      HOME.title,
      HOME.description,
      JSON.stringify(webAppJsonLd()),
      JSON.stringify(macAppJsonLd()),
      NOT_FOUND.title,
      NOT_FOUND.description,
      renderNotFound("/x.css"),
      renderGuide(PLACEHOLDER_GUIDE, "/x.css"),
      robots,
    ];
    for (const text of fresh) expect(text).not.toMatch(/\.(pst|ost|olm)\b/i);
  });

  it("gives every static page its own title", () => {
    const titles = [HOME.title, MAC.title, NOT_FOUND.title, ...GUIDES.map((g) => guidePage(g).title)];
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("robots.txt and not-found handling", () => {
  it("allows everything and names the sitemap", () => {
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
    expect(robots).not.toMatch(/^Disallow:/m);
    expect(robots).toMatch(new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, "m"));
  });

  it("serves 404.html with a 404 for any path that is not a file, rather than the app with a 200", () => {
    expect(wrangler).toMatch(/"not_found_handling":\s*"404-page"/);
    expect(wrangler).not.toMatch(/"not_found_handling":\s*"single-page-application"/);
  });
});

describe("sitemap.xml", () => {
  it("lists /, /mac/ and published guides, and leaves unpublished ones out", () => {
    const pages = [HOME, MAC, ...publishedGuides([FIXTURE_GUIDE, PLACEHOLDER_GUIDE]).map(guidePage)];
    const xml = sitemapXml(pages);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true);
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/mac/`,
      `${ORIGIN}/guides/open-an-msg-file/`,
    ]);
    expect(xml).not.toMatch(/lastmod|changefreq/);
  });

  it("publishes no placeholder", () => {
    expect(PLACEHOLDER_GUIDE.published).toBe(false);
    expect(publishedGuides()).not.toContain(PLACEHOLDER_GUIDE);
  });
});

describe("the guide template", () => {
  const html = renderGuide(FIXTURE_GUIDE, "/assets/site.css");

  it("carries the guide's title, description, canonical and Open Graph tags", () => {
    expect(head(html)).toContain(lines(headTags(guidePage(FIXTURE_GUIDE))));
    expect(guidePage(FIXTURE_GUIDE).path).toBe("/guides/open-an-msg-file/");
    expect(html).toContain('<link rel="canonical" href="https://mailviewer.app/guides/open-an-msg-file/">');
    expect(html).not.toContain("noindex");
  });

  it("has the body, then a For IT section linking /mac/ and the admin guide", () => {
    expect(html.indexOf("FIXTURE-GUIDE-BODY")).toBeLessThan(html.indexOf('<h2 id="for-it">For IT</h2>'));
    const it = html.slice(html.indexOf('<section class="guide-it"'), html.indexOf("</section>", html.indexOf('<section class="guide-it"')));
    expect(it).toContain("FIXTURE-FOR-IT");
    expect(it).toContain('href="/mac/"');
    expect(it).toContain('href="https://updates.mailviewer.app/admin/"');
  });

  it("links the app's routes as another document, and loads only this origin's stylesheet", () => {
    expect(html).toContain('href="/#/open"');
    expect(html).toContain('href="/#/privacy"');
    expect(html).not.toMatch(/href="#\//);
    expect(html).toContain('<link rel="stylesheet" href="/assets/site.css">');
    expect(html).not.toMatch(/<script/i);
  });

  it("keeps an unpublished guide out of search", () => {
    expect(renderGuide(PLACEHOLDER_GUIDE, "/x.css")).toContain('<meta name="robots" content="noindex">');
  });
});

describe("the not-found page", () => {
  const html = renderNotFound("/assets/site.css");
  it("says so, is kept out of search, and links home, the viewer and the Mac page", () => {
    expect(html).toContain(`<title>${NOT_FOUND.title}</title>`);
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('rel="canonical"');
    for (const href of ['href="/"', 'href="/#/open"', 'href="/mac/"']) expect(html).toContain(href);
  });
});

describe("the prerendered home page", () => {
  const html = renderHome();
  it("is the app's home route: hero, format list and the link to the Mac page", () => {
    expect(html).toContain("Open any email file.");
    expect(html).toContain('class="cards cards-4 formats"');
    for (const ext of [".eml", ".msg", ".mbox", ".emlx", ".oft", ".mht"]) expect(html).toContain(`>${ext}<`);
    expect(html).toContain('<a class="maccard" href="/mac">');
    expect(html).toContain('<header class="topbar">');
  });

  it("lists published guides, and has no guides section while there are none", () => {
    expect(publishedGuides()).toEqual([]);
    expect(html).not.toContain('class="section guides"');
    const withGuide = renderToStaticMarkup(createElement(Landing, { guides: [FIXTURE_GUIDE] }));
    expect(withGuide).toContain('<a href="/guides/open-an-msg-file/">Open an .msg file</a>');
  });
});
