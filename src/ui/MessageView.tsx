import { useEffect, useMemo, useState } from "react";
import type { Address, Attachment, Message } from "../lib/model";
import { buildIframeDocument, sanitizeMessageHtml } from "../lib/sanitize";
import { countMatches, highlight, highlightHtml } from "../lib/highlight";
import { type PrintScope, listScopeLabel } from "../lib/printing";

type Tab = "message" | "headers" | "source";

function fmtAddresses(list: Address[]): React.ReactNode {
  if (list.length === 0) return "—";
  return list.map((a, i) => (
    <span key={`${a.email}-${i}`}>
      {i > 0 && ", "}
      {a.name ? (
        <>
          <b>{a.name}</b> &lt;{a.email}&gt;
        </>
      ) : (
        a.email
      )}
    </span>
  ));
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Mint a blob: URL so the user can save an attachment without any network round-trip. */
function useObjectUrl(att: Attachment): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const u = URL.createObjectURL(
      new Blob([att.content.slice() as unknown as BlobPart], { type: att.mimeType }),
    );
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [att]);
  return url;
}

function AttachmentChip({ att }: { att: Attachment }) {
  const url = useObjectUrl(att);
  return (
    <a className="attach" href={url} download={att.filename}>
      <span>{att.filename}</span>
      <span className="attach-size">{fmtSize(att.size)}</span>
    </a>
  );
}

export default function MessageView({
  message,
  query = "",
  listedCount,
  onPrint,
  onPrintMenuToggle,
  printReady,
}: {
  message: Message;
  query?: string;
  /** How many messages the current folder/search shows, for the print menu. */
  listedCount: number;
  onPrint: (scope: PrintScope) => void;
  /** Opening the menu is what starts preparing the all-messages document. */
  onPrintMenuToggle: (open: boolean) => void;
  /** Which scopes have a built, measured document ready to print right now. */
  printReady: Record<PrintScope, boolean>;
}) {
  const [tab, setTab] = useState<Tab>("message");

  useEffect(() => setTab("message"), [message.id]);

  const rendered = useMemo(() => {
    if (!message.html) return null;
    return sanitizeMessageHtml(message.html, message.attachments);
  }, [message]);

  // Highlight AFTER sanitising, on the sanitiser's output -- see highlightHtml.
  const highlighted = useMemo(
    () => (rendered ? highlightHtml(rendered.html, query) : null),
    [rendered, query],
  );

  const srcDoc = useMemo(
    () => (highlighted ? buildIframeDocument(highlighted.html) : null),
    [highlighted],
  );

  // How many times the query appears in whatever body we're actually showing.
  const bodyMatches = highlighted ? highlighted.count : countMatches(message.text, query);

  const files = message.attachments.filter((a) => !a.inline);
  const trackers = rendered?.blockedRemote.filter((b) => b.likelyTracker) ?? [];
  const blocked = rendered?.blockedRemote ?? [];

  const rawText = useMemo(() => {
    if (!message.raw) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(message.raw);
  }, [message]);

  return (
    <div className="msgview">
      <div className="msghead">
        <h1>{highlight(message.subject, query)}</h1>

        <div className="addr-grid">
          <span className="addr-key">From</span>
          <span className="addr-val">{message.from ? fmtAddresses([message.from]) : "—"}</span>

          {/*
            A delegated send: the message is from one person but was submitted by
            another. Mail clients bury this, but it's the difference between "the
            CEO wrote this" and "the CEO's assistant wrote this", so we show it.
          */}
          {message.sender && (
            <>
              <span className="addr-key">Sent by</span>
              <span className="addr-val">
                {fmtAddresses([message.sender])}{" "}
                <span style={{ color: "var(--dim)" }}>on behalf of the sender above</span>
              </span>
            </>
          )}

          <span className="addr-key">To</span>
          <span className="addr-val">{fmtAddresses(message.to)}</span>

          {message.cc.length > 0 && (
            <>
              <span className="addr-key">Cc</span>
              <span className="addr-val">{fmtAddresses(message.cc)}</span>
            </>
          )}

          <span className="addr-key">Date</span>
          <span className="addr-val">
            {message.date ? message.date.toLocaleString() : "—"}
          </span>
        </div>

        <div className="tabs">
          <button
            className={`tab ${tab === "message" ? "active" : ""}`}
            onClick={() => setTab("message")}
          >
            Message
          </button>
          <button
            className={`tab ${tab === "headers" ? "active" : ""}`}
            onClick={() => setTab("headers")}
          >
            Headers
            {message.headers.length > 0 && (
              <span className="tab-badge">{message.headers.length}</span>
            )}
          </button>
          {rawText && (
            <button
              className={`tab ${tab === "source" ? "active" : ""}`}
              onClick={() => setTab("source")}
            >
              Raw source
            </button>
          )}

          {/*
            Printing offers an explicit choice rather than guessing. Someone
            producing an exhibit needs to know exactly what is in it, and "print"
            meaning "whatever happened to be on screen" is not good enough when
            the artifact outlives the session that made it.

            Opening the menu is what starts preparing the documents, so that
            choosing an option can call window.print() with no awaited work in
            between -- the print modal only opens against a live user gesture.
            An option stays disabled until its document is measured, because the
            alternative is printing frames of unknown height, which is the bug
            two changes ago.
          */}
          <details
            className="printmenu"
            onToggle={(e) => onPrintMenuToggle(e.currentTarget.open)}
          >
            <summary title="Print or save as PDF">Print</summary>
            <div className="printmenu-pop">
              {(["message", "list"] as const).map((scope) => (
                <button
                  key={scope}
                  disabled={!printReady[scope]}
                  onClick={(e) => {
                    e.currentTarget.closest("details")?.removeAttribute("open");
                    onPrint(scope);
                  }}
                >
                  {scope === "message" ? "This message" : listScopeLabel(listedCount)}
                  {!printReady[scope] && <span className="printmenu-wait">Preparing…</span>}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>

      {tab === "message" && query.trim() && (
        <div className="match-strip">
          {bodyMatches > 0
            ? `${bodyMatches} match${bodyMatches === 1 ? "" : "es"} for “${query.trim()}” in this message`
            : `No matches for “${query.trim()}” in the body — it matched elsewhere (sender, subject or recipients).`}
        </div>
      )}

      {tab === "message" && blocked.length > 0 && (
        <div className="blocked-banner">
          <b>
            {blocked.length} remote {blocked.length === 1 ? "resource" : "resources"} blocked
          </b>
          {trackers.length > 0 && (
            <span>
              {" · "}
              {trackers.length} {trackers.length === 1 ? "looks" : "look"} like a tracking pixel.
              The sender was not told you opened this.
            </span>
          )}
        </div>
      )}

      {tab === "message" && (
        // A body is the sender's document rather than part of the app, so it
        // sits on a light canvas whichever element renders it.
        <div className={srcDoc || message.text ? "msgbody msgbody-canvas" : "msgbody"}>
          {srcDoc ? (
            <iframe
              key={message.id}
              title="Message body"
              // Locked down to the minimum a mail body needs: it may lay itself
              // out, and nothing else. No scripts, no forms, no popups, and a
              // null origin so it cannot reach back into the app.
              sandbox=""
              srcDoc={srcDoc}
            />
          ) : message.text ? (
            <pre className="plaintext">{highlight(message.text, query)}</pre>
          ) : (
            <div className="empty">This message has no readable body.</div>
          )}
        </div>
      )}

      {tab === "headers" && (
        <div className="msgbody">
          {message.headers.length === 0 ? (
            <div className="empty">
              This format doesn't carry the original internet headers.
            </div>
          ) : (
            <table className="headers-table">
              <tbody>
                {message.headers.map((h, i) => (
                  <tr key={`${h.key}-${i}`}>
                    <td>{h.key}</td>
                    <td>{h.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "source" && rawText && (
        <div className="msgbody">
          <pre className="plaintext">{rawText}</pre>
        </div>
      )}

      {files.length > 0 && (
        <div className="attach-list">
          {files.map((a) => (
            <AttachmentChip key={a.id} att={a} />
          ))}
        </div>
      )}
    </div>
  );
}
