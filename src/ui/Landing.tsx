import NetworkMonitor from "./NetworkMonitor";

const FORMATS = [
  { ext: ".eml", name: "Standard email", note: "RFC 5322 / MIME. What most clients export." },
  { ext: ".emlx", name: "Apple Mail", note: "The same message, wrapped in Apple's byte-count header." },
  { ext: ".msg", name: "Outlook message", note: "Compound-file MAPI. Read without owning Outlook." },
  { ext: ".mbox", name: "Mail archive", note: "Gmail Takeout, Thunderbird. Thousands of messages in one file." },
  { ext: ".pst / .ost", name: "Outlook data file", note: "The whole mailbox, folder tree intact." },
];

export default function Landing() {
  return (
    <>
      <section className="hero">
        <div>
          {/*
            The hero is a header block, because a header block is the artifact
            this product exists to handle. The claims are stated in the format
            they describe.
          */}
          <div className="headerblock">
            <div className="hb-row">
              <span className="hb-key">X-Processing:</span>
              <span className="hb-val verified">local — in this browser tab</span>
            </div>
            <div className="hb-row">
              <span className="hb-key">X-Uploads:</span>
              <span className="hb-val verified">none, and none are possible</span>
            </div>
            <div className="hb-row">
              <span className="hb-key">X-Enforced-By:</span>
              <span className="hb-val">Content-Security-Policy: connect-src 'none'</span>
            </div>
          </div>

          <h1>
            Read any email file.
            <br />
            It <span className="em">never leaves</span> your browser.
          </h1>

          <p className="lede">
            Drop in a .eml, .msg, .mbox or .pst and read it — headers, HTML, attachments,
            folder tree and all. The file is opened by JavaScript on your own machine.
            Nothing is uploaded, because this page is served with a policy that makes
            uploading impossible.
          </p>

          <div className="hero-cta">
            <a className="btn btn-primary" href="#/open">
              Open a file
            </a>
            <a className="btn" href="#/verify">
              Prove it to me
            </a>
          </div>
        </div>

        <div>
          <NetworkMonitor />
        </div>
      </section>

      <hr className="rule" />

      <section className="section">
        <h2>Formats</h2>
        <h3>Every mail file you're likely to be handed</h3>
        <p>
          Files are identified by their contents, not their extension — so a .msg that
          someone renamed to .eml still opens correctly.
        </p>

        <div className="formats">
          {FORMATS.map((f) => (
            <div className="format" key={f.ext}>
              <div className="format-ext">{f.ext}</div>
              <div className="format-name">{f.name}</div>
              <div className="format-note">{f.note}</div>
            </div>
          ))}
        </div>
      </section>

      <hr className="rule" />

      <section className="section">
        <h2>Why this is safe</h2>
        <h3>The guarantee is structural, not a promise</h3>
        <p>
          Most "private" web tools ask you to trust that their server deletes your data.
          This one has no server to send anything to. There is no backend, no API, no
          upload endpoint, and no analytics. The site is a folder of static files.
        </p>

        <div className="steps" style={{ counterReset: "none" }}>
          <div className="step" style={{ gridTemplateColumns: "1fr" }}>
            <div>
              <h4>The browser refuses to let this page open a connection</h4>
              <p>
                Every response is served with{" "}
                <code>Content-Security-Policy: … connect-src 'none'</code>. That directive
                tells your browser to block <code>fetch()</code>,{" "}
                <code>XMLHttpRequest</code>, WebSockets, <code>EventSource</code> and{" "}
                <code>sendBeacon</code> — every mechanism a page has for talking to a
                server. Not "we choose not to use them". The browser will not permit them.
              </p>
              <p>
                So even if this app were malicious, or a dependency were compromised
                tomorrow, the code still could not send your mail anywhere. The enforcement
                happens in your browser, not in our code.
              </p>
            </div>
          </div>

          <div className="step" style={{ gridTemplateColumns: "1fr" }}>
            <div>
              <h4>Tracking pixels in your mail are dead on arrival</h4>
              <p>
                Marketing email is full of 1×1 images that tell the sender you opened the
                message. Because <code>img-src</code> is restricted to this origin, those
                images cannot load — the viewer shows you how many it neutralised, and who
                was trying to phone home.
              </p>
            </div>
          </div>

          <div className="step" style={{ gridTemplateColumns: "1fr" }}>
            <div>
              <h4>It works with your network turned off</h4>
              <p>
                The strongest test we can offer: load the page, go offline, and open your
                mail anyway. If the app needed a server, it would break. It doesn't.
              </p>
            </div>
          </div>
        </div>

        <div className="callout">
          <strong>Don't trust any of that.</strong> Every claim on this page is checkable in
          about ninety seconds with the DevTools you already have.{" "}
          <a href="#/verify">Here's exactly how →</a>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <span>Mailviewer — a static site. No server, no accounts, no analytics.</span>
          <a href="#/verify">Verify</a>
          <a href="https://github.com/dminnema/mailviewer" target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </div>
      </footer>
    </>
  );
}
