// The static half of the build, run after `vite build` (npm run build).
//
//   node scripts/build-static.mjs [distDir]
//
// - dist/index.html: the home page rendered into #root, so a crawler that runs
//   no JavaScript reads the page a person sees. The app mounts over it.
// - dist/guides/<slug>/index.html: each guide, from the template.
// - dist/404.html: what Cloudflare serves, with status 404, for any path that
//   is not a file (wrangler.jsonc, not_found_handling).
// - dist/sitemap.xml: /, /mac/ and every published guide.
//
// The renderers are TypeScript and React, loaded through Vite's SSR loader in
// middleware mode: nothing listens on a port and nothing touches the network.
// The output has no dates in it, so the same commit builds the same files.
import { createServer } from "vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DIST = process.argv[2] ?? join(ROOT, "dist");

const vite = await createServer({
  root: ROOT,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const { renderHome, renderGuide, renderNotFound } = await vite.ssrLoadModule("/src/site/render.tsx");
  const { HOME, MAC, sitemapXml } = await vite.ssrLoadModule("/src/site/pages.ts");
  const { GUIDES, guidePage, publishedGuides } = await vite.ssrLoadModule("/src/site/guides.ts");

  const indexPath = join(DIST, "index.html");
  const index = readFileSync(indexPath, "utf8");
  const slot = '<div id="root"></div>';
  if (index.split(slot).length !== 2) throw new Error(`dist/index.html must contain ${slot} exactly once`);
  writeFileSync(indexPath, index.replace(slot, `<div id="root">${renderHome()}</div>`));

  // The app's stylesheet, as Vite named it, for the pages built here.
  const stylesheet = index.match(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"/)?.[1];
  if (!stylesheet) throw new Error("no stylesheet link in dist/index.html");

  for (const guide of GUIDES) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(guide.slug)) throw new Error(`bad guide slug: ${guide.slug}`);
    const dir = join(DIST, "guides", guide.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderGuide(guide, stylesheet));
  }

  writeFileSync(join(DIST, "404.html"), renderNotFound(stylesheet));
  writeFileSync(join(DIST, "sitemap.xml"), sitemapXml([HOME, MAC, ...publishedGuides().map(guidePage)]));

  console.log(`static pages: /, ${GUIDES.length} guide(s) (${publishedGuides().length} published), 404.html, sitemap.xml`);
} finally {
  await vite.close();
}
