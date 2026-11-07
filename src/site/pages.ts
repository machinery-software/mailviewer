/**
 * The site's static pages, as search engines and link previews see them: the
 * one record of each page's address, title and description.
 *
 * The home page (index.html) and the Mac page (public/mac/index.html) are
 * written by hand, head and all, like the rest of those files; the guides and
 * the not-found page are built from a template (render.tsx). Either way the
 * binding is the test: src/__tests__/seo.test.ts fails if a page's head does
 * not carry exactly what headTags() makes of its entry here.
 *
 * Nothing in a head loads anything. og:image is an address a link-preview
 * crawler fetches from this origin; a browser showing the page never does.
 */
import { MAC_PURCHASE_LINKS, MAC_APP_VERSION, MAC_DOWNLOAD_URL } from "../lib/mac-purchase-links";
import { MAC_PLANS, overageLine } from "../lib/mac-pricing";
import { COMPANY_NAME, COMPANY_URL } from "../config";

export const ORIGIN = "https://mailviewer.app";

/** public/og.png, 1200×630, made by scripts/og-image.mjs. */
export const OG_IMAGE = `${ORIGIN}/og.png`;

export interface StaticPage {
  /** The canonical path, with its trailing slash. */
  path: string;
  title: string;
  description: string;
  ogType: "website" | "article";
}

/*
 * TODO(PR #29, MAC-513): the claims below name only formats that open in the
 * production build today. When PR #29 merges, .olm opens and may be named here
 * and in the home page's title; .pst and .ost wait for a PST fixture
 * (MAC-526). Until then no new text names .pst, .ost or .olm.
 */
export const HOME: StaticPage = {
  path: "/",
  title: "Mailviewer: read .eml, .msg and .mbox files in your browser",
  description:
    "Open .eml, .emlx, .msg and .mbox email files in your browser. Nothing is uploaded: the page cannot send your mail anywhere, and you can check that in DevTools.",
  ogType: "website",
};

/** public/mac/index.html. Title and description as the page has carried them since MAC-787. */
export const MAC: StaticPage = {
  path: "/mac/",
  title: "Mailviewer for Mac: open any email file on your Mac",
  description:
    "Open .msg, .eml, .mbox, Apple Mail mailboxes and Google Takeout exports on a Mac, with Space bar previews. Nothing leaves the Mac. Plans for teams and organizations.",
  ogType: "website",
};

export const NOT_FOUND = {
  title: "Page not found · Mailviewer",
  description: "There is no page at this address. Mailviewer opens email files in your browser, and nothing is uploaded.",
};

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Title, description, canonical and Open Graph tags for a page, one per line,
 * exactly as the hand-written pages carry them.
 */
export function headTags(page: StaticPage): string {
  const url = `${ORIGIN}${page.path}`;
  return [
    `<title>${escapeAttr(page.title)}</title>`,
    `<meta name="description" content="${escapeAttr(page.description)}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="${page.ogType}">`,
    `<meta property="og:site_name" content="Mailviewer">`,
    `<meta property="og:title" content="${escapeAttr(page.title)}">`,
    `<meta property="og:description" content="${escapeAttr(page.description)}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join("\n");
}

/**
 * A JSON-LD block. A data block, not a script: the browser never runs it, so
 * script-src 'self' has nothing to say about it.
 */
export function jsonLdScript(data: unknown): string {
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, "\\u003c")}\n</script>`;
}

const publisher = { "@type": "Organization", name: `${COMPANY_NAME} LLC`, url: COMPANY_URL };

/** The web app, on the home page. Free. */
export function webAppJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Mailviewer",
    url: `${ORIGIN}/`,
    description: HOME.description,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Any",
    browserRequirements: "Requires JavaScript.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher,
  };
}

/**
 * The Mac app, on /mac/. Offers are the plans the page sells, priced from
 * src/lib/mac-pricing.ts, so they cannot say something the cards do not.
 * Personal is not among them: the page cannot sell it yet (its button is a
 * disabled "Coming to the Mac App Store"), and an offer search engines show
 * with a price should be one a reader can take. It joins when it has a
 * purchase link.
 */
export function macAppJsonLd() {
  const yearly = (name: string, price: number, url: string, description?: string) => ({
    "@type": "Offer",
    name,
    ...(description ? { description } : {}),
    price: String(price),
    priceCurrency: "USD",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: String(price),
      priceCurrency: "USD",
      billingDuration: "P1Y",
    },
    url,
  });
  const { team, business, site } = MAC_PLANS;
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Mailviewer for Mac",
    url: `${ORIGIN}${MAC.path}`,
    description: MAC.description,
    operatingSystem: "macOS",
    applicationCategory: "UtilitiesApplication",
    softwareVersion: MAC_APP_VERSION,
    downloadUrl: MAC_DOWNLOAD_URL,
    offers: [
      yearly(team.name, team.price, MAC_PURCHASE_LINKS.team, overageLine(team)),
      yearly(business.name, business.price, MAC_PURCHASE_LINKS.business, overageLine(business)),
      yearly(site.name, site.price, MAC_PURCHASE_LINKS.site[1]),
    ],
    publisher,
  };
}

/** sitemap.xml for the given pages. No dates: the build is reproducible (DEPLOYMENT.md §5). */
export function sitemapXml(pages: StaticPage[]): string {
  const urls = pages.map((p) => `  <url><loc>${escapeAttr(`${ORIGIN}${p.path}`)}</loc></url>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}
