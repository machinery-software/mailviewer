import { useRef, useState } from "react";
import { setPendingFiles } from "../lib/pendingFiles";
import { COMPANY_NAME, COMPANY_URL } from "../config";
import { Footer } from "./Footer";

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

export default function Landing() {
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
        <div className="hero2-copy">
          <div className="eyebrow">Email viewer · runs in your browser</div>
          <h1>
            Open any email file.
            <br />
            Read it right here.
          </h1>
          <p className="lede">
            Drag in an export from Outlook, Apple Mail or Gmail — <b>.eml</b>, <b>.msg</b>,{" "}
            <b>.pst</b>, <b>.mbox</b> and more — and read it like a mail app: folders, threads,
            attachments and all. Open as many files as you like and browse across them together.
          </p>

          <div className="privacy-chip">
            <span className="lock" aria-hidden="true">🔒</span>
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
            <div className="bigdrop-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" width="48" height="48">
                <rect x="7" y="12" width="34" height="24" rx="3" fill="none" stroke="var(--teal)" strokeWidth="2.4" />
                <path d="M7 14l17 13 17-13" fill="none" stroke="var(--teal)" strokeWidth="2.4" strokeLinejoin="round" />
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
      </section>

      <hr className="rule" />

      <section className="section">
        <h2>Formats</h2>
        <h3>Every mail file you're likely to be handed</h3>
        <p>
          Files are identified by their contents, not their extension — so a .msg that someone
          renamed to .eml still opens correctly. Notes files (.nsf) and Outlook Express (.dbx)
          are recognised too, with a note on how to convert them.
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
        <h2>Privacy</h2>
        <h3>Your mail stays yours</h3>
        <p>
          This is a viewer, not a service. It has no account to create and no server to upload
          to — the page is a set of static files, and your mail is read entirely by code running
          in this tab.
        </p>

        <div className="privacy-cards">
          <div className="pcard">
            <div className="pcard-h">Nothing is uploaded</div>
            <p>Your files are read locally. They never travel to us or anyone else.</p>
          </div>
          <div className="pcard">
            <div className="pcard-h">No tracking</div>
            <p>No analytics, no accounts, no cookies. Tracking pixels in your mail are blocked.</p>
          </div>
          <div className="pcard">
            <div className="pcard-h">You can prove it</div>
            <p>The browser itself enforces this, and you can confirm it in DevTools in a minute.</p>
          </div>
        </div>

        <div className="privacy-links">
          <a className="btn" href="#/privacy">
            How your privacy is protected
          </a>
          <a className="btn" href="#/verify">
            Verify it yourself
          </a>
        </div>
      </section>

      <Footer note="A static site. No server, no accounts, no analytics." />
    </>
  );
}
