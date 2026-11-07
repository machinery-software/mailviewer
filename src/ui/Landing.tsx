import { useRef, useState } from "react";
import { setPendingFiles } from "../lib/pendingFiles";
import { COMPANY_NAME, COMPANY_URL } from "../config";
import { type Guide, guidePage, publishedGuides } from "../site/guides";
import { Footer } from "./Footer";
import { Logo } from "./Logo";

const FORMATS = [
  { ext: ".eml", name: "Standard email", note: "RFC 5322 / MIME. What most clients export." },
  { ext: ".msg", name: "Outlook message", note: "Read one without owning Outlook." },
  { ext: ".pst / .ost", name: "Outlook data file", note: "A whole mailbox, folder tree intact." },
  { ext: ".mbox", name: "Mail archive", note: "Gmail Takeout, Thunderbird, Apple Mail." },
  { ext: ".olm", name: "Outlook for Mac", note: "The Mac export archive, unzipped for you." },
  { ext: ".emlx", name: "Apple Mail", note: "A single message saved by Mail.app." },
  { ext: ".oft", name: "Outlook template", note: "The template form, read as a message." },
  { ext: ".mht", name: "Saved web archive", note: "MHTML, with inline images resolved." },
];

const ACCEPT = ".eml,.emlx,.msg,.oft,.mbox,.mbx,.pst,.ost,.olm,.mht,.mhtml,message/rfc822";

/** `guides` is for tests; the page lists the published ones (src/site/guides.ts). */
export default function Landing({ guides = publishedGuides() }: { guides?: Guide[] }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Files chosen here are handed to the viewer route, which does the reading.
  const open = (files: File[]) => {
    if (!files.length) return;
    setPendingFiles(files);
    location.hash = "#/open";
  };

  return (
    <>
      <section className="hero2">
        <div className="glow" aria-hidden="true" />
        <div className="gridlines" aria-hidden="true" />
        <div className="hero2-inner">
          <div className="hero2-copy">
            <span className="chip">
              <span className="chip-dot" aria-hidden="true" />
              Email viewer · runs in your browser
            </span>
            <h1>
              Open any email file. <span className="soft">Read it right here.</span>
            </h1>
            <p className="lede">
              Drag in an export from Outlook, Apple Mail or Gmail — <b>.eml</b>, <b>.msg</b>,{" "}
              <b>.pst</b>, <b>.mbox</b> and more — and read it like a mail app: folders, threads,
              attachments and all. Open as many files as you like and browse across them together.
            </p>

            <div className="privacy-chip">
              <span className="lock" aria-hidden="true">
                🔒
              </span>
              <span>
                <b>Private by design.</b> Your files are opened on your own device and never
                uploaded. <a href="#/privacy">See how it works →</a>
              </span>
            </div>

            <p className="hero2-byline">
              A free tool, built and maintained by{" "}
              <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer">
                {COMPANY_NAME}
              </a>
              .
            </p>
          </div>

          <div className="hero2-drop">
            <div
              className={`bigdrop ${dragOver ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                open([...e.dataTransfer.files]);
              }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
              }}
            >
              <div className="bigdrop-icon ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#8FEBD6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 16V4" />
                  <path d="M7 9l5-5 5 5" />
                  <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
              </div>
              <div className="bigdrop-title">Drop email files here</div>
              <div className="bigdrop-sub">or click to choose — you can pick several</div>
              <input
                ref={inputRef}
                type="file"
                hidden
                multiple
                accept={ACCEPT}
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = "";
                  open(files);
                }}
              />
            </div>
            <div className="hero2-note">Nothing leaves this page. No upload, no account, no waiting.</div>
          </div>
        </div>
      </section>

      {/* The Mac app, below the viewer's intro (MAC-787): the one thing the site sells. */}
      <div className="maccard-wrap">
        <a className="maccard" href="/mac">
          <span className="maccard-logo" aria-hidden="true">
            <Logo />
          </span>
          <span className="maccard-copy">
            <span className="maccard-title">Mailviewer for Mac</span>
            <span className="maccard-text">
              The same viewer as a native app, with Quick Look, mailboxes and MDM deployment.
            </span>
          </span>
          <span className="maccard-cta">
            Download free, license for teams <span aria-hidden="true">→</span>
          </span>
        </a>
      </div>

      <div className="band">
        <section className="section">
          <h2>Formats</h2>
          <h3>Every mail file you're likely to be handed</h3>
          <p>
            Files are identified by their contents, not their extension — so a .msg that someone
            renamed to .eml still opens correctly. Notes files (.nsf) and Outlook Express (.dbx)
            are recognised too, with a note on how to convert them.
          </p>

          <div className="cards cards-4 formats">
            {FORMATS.map((f) => (
              <div className="feature format" key={f.ext}>
                <div className="format-ext">{f.ext}</div>
                <div className="format-name">{f.name}</div>
                <div className="format-note">{f.note}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Privacy</h2>
        <h3>Your mail stays yours</h3>
        <p>
          This is a viewer, not a service. It has no account to create and no server to upload
          to — the page is a set of static files, and your mail is read entirely by code running
          in this tab.
        </p>

        <div className="cards cards-3 privacy-cards">
          <div className="feature pcard">
            <h4 className="feature-h">Nothing is uploaded</h4>
            <p>Your files are read locally. They never travel to us or anyone else.</p>
          </div>
          <div className="feature pcard">
            <h4 className="feature-h">No tracking</h4>
            <p>No analytics, no accounts, no cookies. Tracking pixels in your mail are blocked.</p>
          </div>
          <div className="feature pcard">
            <h4 className="feature-h">You can prove it</h4>
            <p>The browser itself enforces this, and you can confirm it in DevTools in a minute.</p>
          </div>
        </div>

        <div className="privacy-links">
          <a className="btn btn-primary" href="#/privacy">
            How your privacy is protected
          </a>
          <a className="btn" href="#/verify">
            Verify it yourself
          </a>
        </div>
      </section>

      {/* Only once there is a published guide; until then the section is absent. */}
      {guides.length > 0 && (
        <section className="section guides">
          <h2>Guides</h2>
          <h3>How to open what you have been sent</h3>
          <ul className="guide-list">
            {guides.map((g) => (
              <li key={g.slug}>
                <a href={guidePage(g).path}>{g.title}</a>
                <span>{g.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Footer note="A static site. No server, no accounts, no analytics." />
    </>
  );
}
