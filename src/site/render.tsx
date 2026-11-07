/**
 * Static HTML for the pages that are not the app: the home page's prerendered
 * body, the guides and the not-found page. Called at build time by
 * scripts/build-static.mjs, never in the browser.
 *
 * The home page is the app itself, rendered once for the home route, so a
 * crawler that runs no JavaScript reads exactly what a person sees, and the
 * app mounts over it unchanged.
 */
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";
import { Footer } from "../ui/Footer";
import { Topbar } from "../ui/Topbar";
import { type Guide, guidePage } from "./guides";
import { NOT_FOUND, headTags } from "./pages";

export function renderHome(): string {
  return renderToStaticMarkup(<App initialRoute="home" />);
}

const IT_ADMIN_GUIDE = "https://updates.mailviewer.app/admin/";

/** The parts every static page shares, around its own head lines and body. */
function documentFor(head: string, body: string, stylesheet: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    head,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="theme-color" content="#0B1211">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    `<link rel="stylesheet" href="${stylesheet}">`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/** One guide, at /guides/<slug>/. `stylesheet` is the app's built CSS. */
export function renderGuide(guide: Guide, stylesheet: string): string {
  const page = guidePage(guide);
  const head = guide.published ? headTags(page) : `${headTags(page)}\n<meta name="robots" content="noindex">`;
  const body = renderToStaticMarkup(
    <div className="shell">
      <Topbar base="/" />
      <main className="section guide">
        <p className="guide-eyebrow">Guide</p>
        <h1>{guide.title}</h1>
        <p className="lede">{guide.description}</p>
        <div className="guide-body" dangerouslySetInnerHTML={{ __html: guide.body }} />
        {/* The "For IT" slot: on every guide, for whoever rolls this out to a fleet. */}
        <section className="guide-it" aria-labelledby="for-it">
          <h2 id="for-it">For IT</h2>
          {guide.forIT && <div dangerouslySetInnerHTML={{ __html: guide.forIT }} />}
          <p>
            For a fleet of Macs, there is <a href="/mac/">Mailviewer for Mac</a>. The{" "}
            <a href={IT_ADMIN_GUIDE}>admin guide</a> covers installing and updating it, the settings
            an organization can lock, and license keys.
          </p>
        </section>
      </main>
      <Footer base="/" />
    </div>,
  );
  return documentFor(head, body, stylesheet);
}

/** /404.html, which Cloudflare serves with status 404 for any path that is not a file. */
export function renderNotFound(stylesheet: string): string {
  const head = [
    `<title>${NOT_FOUND.title}</title>`,
    `<meta name="description" content="${NOT_FOUND.description}">`,
    '<meta name="robots" content="noindex">',
  ].join("\n");
  const body = renderToStaticMarkup(
    <div className="shell">
      <Topbar base="/" />
      <main className="section notfound">
        <h1>There is no page here</h1>
        <p className="lede">
          The address may be mistyped, or the page may have moved. Mailviewer itself is one page:
          everything it does happens at <a href="/">mailviewer.app</a>.
        </p>
        <p className="notfound-links">
          <a className="btn btn-primary" href="/#/open">
            Open a file
          </a>
          <a className="btn" href="/">
            Home
          </a>
          <a className="btn" href="/mac/">
            Mailviewer for Mac
          </a>
        </p>
      </main>
      <Footer base="/" />
    </div>,
  );
  return documentFor(head, body, stylesheet);
}
