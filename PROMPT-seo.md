# Brief (7 November 2026): SEO pass

PR 3 of three, started after PR 1 (MAC-513, #29) was open, using its format table. Branch from main, own PR, do not merge or promote. Nothing may add a network request, a tracker or a third-party script; the CSP and the no-transform header stay exactly as they are.

1. Static home page. mailviewer.app/ is a 1 KB SPA shell titled "Mailviewer"; crawlers that don't run JS see nothing. Prerender / at build time (the way /mac/ is static) with a real title, the hero text, the format list and links to /mac/ and the guides. The app still boots on top of it.
2. robots.txt and sitemap.xml currently return the SPA HTML with 200, as does every unknown path. Serve a real robots.txt (allow all, with a Sitemap: line) and a sitemap.xml listing /, /mac/ and every static guide page. Unknown paths return 404 with a small static not-found page, except the routes the SPA actually serves. Tests: a made-up path returns 404; robots.txt is text/plain; sitemap.xml is valid XML and lists only URLs that return 200.
3. On every static page: link rel=canonical, unique title, meta description, og:title, og:description, og:url, og:image (a static image in the repo, no external host).
4. Structured data: SoftwareApplication JSON-LD on /mac/ (name "Mailviewer for Mac", operatingSystem macOS, applicationCategory, offers generated from src/lib/mac-pricing.ts so it cannot drift). WebApplication JSON-LD on / for the web app, price 0. No HowTo or FAQ markup.
5. Claims: the meta description and format list must match PR 1's format table. If PR 1 isn't merged when you finish, leave a TODO naming it and advertise no .pst, .ost or .olm in any new text.
6. Guide template: a static route pattern /guides/<slug>/ with title, description, canonical, a "For IT" section slot linking /mac/ and https://updates.mailviewer.app/admin/, and a sitemap entry. One placeholder guide for the template test; do not write the guides.
7. Tests for each item, then scripts/check-apex.sh and the print suite. In the PR body, list for David: the Cloudflare toggles (Crawler Hints on, Early Hints on, HTTP/3 on, Block AI bots off, Rocket Loader / Auto Minify / Email Obfuscation off) and the DNS TXT records he needs for Google Search Console and Bing Webmaster Tools on mailviewer.app and updates.mailviewer.app.

## Findings (7 November)

- `wrangler dev` reproduces the reported behaviour exactly with main's build: /robots.txt, /sitemap.xml and any made-up path return the 1,114-byte app shell with 200. The cause is `not_found_handling: "single-page-application"`; every app route is a hash on /, so "404-page" loses nothing.
- The /mac/ JSON-LD is written into the static page and held to mac-pricing.ts by test (src/__tests__/seo.test.ts), not injected by the build: the page is copied into dist untouched by design (MAC-791 notes). Its offers are the plans the page sells (Team, Business, Site 1-year); Personal is left out while its button is "Coming to the Mac App Store".
- PR #29 is not merged: no new text names .pst, .ost or .olm (TODO in src/site/pages.ts). The prerendered home page is the app's existing Landing, whose format list still names them, as the live app does.
- The placeholder guide (/guides/template-check/) is built but unpublished: noindex, not in the sitemap, not linked.
- mailviewer.app already has a google-site-verification TXT record. updates.mailviewer.app is proxied A/AAAA (no CNAME), so a TXT can sit there. Bing verifies by CNAME (<code> → verify.bing.com), not TXT, or by import from Search Console.
- check-apex.sh against production today: no beacon, no-transform present; robots.txt, sitemap.xml and a made-up path all fail (200 text/html), as expected before this ships.
