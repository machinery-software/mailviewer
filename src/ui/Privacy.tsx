import NetworkMonitor from "./NetworkMonitor";
import { SOURCE_URL } from "../config";
import { Footer } from "./Footer";

export default function Privacy() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Privacy</h2>
        <h3>Your mail is opened on your device and never leaves it</h3>
        <p>
          Most tools that read your files ask you to upload them, then promise to delete them
          afterwards. This one is built the other way round: there is nowhere to upload to. The
          site is a folder of static files, your mail is parsed by JavaScript running in this
          browser tab, and the browser is configured to <em>refuse</em> any attempt to send it
          somewhere. Below is exactly what that means — and how you can check it rather than
          take our word for it.
        </p>

        <div className="prose-block">
          <h4>What we collect</h4>
          <p>
            Nothing. There are no accounts, no cookies, no analytics, and no logs of what you
            open. We couldn't build a profile of you if we wanted to, because your files and
            everything you do with them stay on your machine.
          </p>

          <h4>There is no server to send anything to</h4>
          <p>
            The whole app is downloaded to your browser once, like opening a document. After
            that it runs on its own. There is no backend, no API, and no upload endpoint — so
            there is no place your mail <em>could</em> go, even in principle.
          </p>

          <h4>The browser enforces it, not just our good intentions</h4>
          <p>
            Every page is served with a strict <b>Content-Security-Policy</b>. The key part is{" "}
            <code>connect-src 'none'</code>, which tells your browser to block every way a web
            page can talk to a server — <code>fetch</code>, <code>XMLHttpRequest</code>,
            WebSockets, and background beacons. This is enforced by the browser itself. So even
            if our code had a bug, or a dependency were tampered with, the code still could not
            send your mail anywhere. The rule is what makes the promise real.
          </p>

          <h4>Tracking pixels in your mail are blocked</h4>
          <p>
            Marketing email is full of invisible 1×1 images that quietly tell the sender you
            opened the message. The viewer strips remote images and shows you how many it
            neutralised, so opening a message here doesn't report back to anyone. Images that
            are genuinely part of a message (an embedded logo, a photo) still display — they're
            read from the file itself, not fetched from the web.
          </p>

          <h4>Even the host's own analytics can't get through</h4>
          <p>
            Hosting platforms sometimes inject an analytics script into a page at their edge,
            after our code has run. This site's policy refuses it. If you look at the live
            monitor below or your browser's tools, you may see a <em>blocked</em> request to an
            analytics domain — that's the browser turning it away before a single byte is sent.
            We surface it on purpose: it's the same protection that stops the app itself from
            phoning home.
          </p>

          <h4>It works with the network off</h4>
          <p>
            The simplest proof of all: load this page, disconnect from the internet, and open a
            file. It works completely. An app that secretly needed to upload your mail could not
            possibly do that.
          </p>
        </div>

        <div className="callout">
          <strong>Don't take our word for it.</strong> Everything above is checkable in about a
          minute with the developer tools already in your browser.{" "}
          <a href="#/verify">Here's the step-by-step →</a>
        </div>

        <div className="callout warn">
          <strong style={{ color: "var(--amber)" }}>One honest caveat.</strong> Checking the
          page today doesn't guarantee it forever — any website can ship different code
          tomorrow. Your protections are that the{" "}
          <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
            source is public
          </a>
          , the site is static with no server-side logic, and the check takes a minute and can
          be repeated any time. For a permanent guarantee, download the source, run{" "}
          <code>npm run build</code>, and open it from your own disk — it behaves identically
          offline.
        </div>
      </section>

      <hr className="rule" />

      <section className="section section-narrow">
        <h2>Live</h2>
        <h3>What this page has done since you opened it</h3>
        <p>
          Read from inside the page: every request that loaded (all this site's own code) and
          every request the browser blocked. The number that would matter — data actually sent
          to another server — stays at zero, with a warning ready if it ever isn't.
        </p>
        <div style={{ marginTop: 24 }}>
          <NetworkMonitor />
        </div>
      </section>

      <Footer
        note={
          <>
            Found a way to make this page leak data? That's a bug — please 
            <a href="#/report">report it</a>.
          </>
        }
      />
    </>
  );
}
