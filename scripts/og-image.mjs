// Draws public/og.png, the 1200×630 image link previews show for every page
// (og:image in src/site/pages.ts). Served from this origin like any other
// file; nothing about it is fetched from anywhere else.
//
//   node scripts/og-image.mjs
//
// Rendered by Playwright's Chromium from the HTML below, with the site's
// palette and the one Mailviewer mark (src/ui/Logo.tsx). Run it again after
// changing either; the PNG is committed, so the build does not draw it.
import { chromium } from "playwright";

const OUT = new URL("../public/og.png", import.meta.url).pathname;

const LOGO = `<svg viewBox="0 0 32 32" width="132" height="132" aria-hidden="true">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6FE4CB"/><stop offset="1" stop-color="#2FB89C"/></linearGradient></defs>
  <rect x="0" y="0" width="32" height="32" rx="8" fill="url(#g)"/>
  <rect x="6" y="9" width="17" height="12" rx="2" fill="#FFFFFF"/>
  <path d="M6.5 10 L14.5 16 L22.5 10" fill="none" stroke="#1F6F62" stroke-width="1.6"/>
  <circle cx="21" cy="19.5" r="4.2" fill="none" stroke="#FFFFFF" stroke-width="1.8"/>
  <path d="M24 22.5 L27 25.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>
</svg>`;

const HTML = `<!doctype html><html><head><style>
  html,body{margin:0;width:1200px;height:630px;background:#0B1211;color:#ECF2F0;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .card{position:relative;box-sizing:border-box;width:1200px;height:630px;padding:88px 96px;overflow:hidden;
    background:radial-gradient(900px 480px at 15% 0%,rgba(63,208,179,0.18),transparent 60%),
               radial-gradient(700px 420px at 95% 20%,rgba(31,95,174,0.16),transparent 60%),#0B1211}
  .row{display:flex;align-items:center;gap:36px}
  .name{font-size:92px;font-weight:700;letter-spacing:-0.03em}
  .line{margin-top:56px;font-size:46px;line-height:1.25;font-weight:600;letter-spacing:-0.01em;max-width:960px}
  .soft{color:#A7B5B1}
  .url{position:absolute;left:96px;bottom:72px;font-size:30px;color:#3FD0B3;font-weight:600}
</style></head><body><div class="card">
  <div class="row">${LOGO}<div class="name">Mailviewer</div></div>
  <div class="line">Open email files in your browser.<br><span class="soft">Nothing is uploaded.</span></div>
  <div class="url">mailviewer.app</div>
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(HTML);
await page.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
