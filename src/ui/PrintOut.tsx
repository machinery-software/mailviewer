import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Message } from "../lib/model";
import { buildIframeDocument, sanitizeMessageHtml } from "../lib/sanitize";
import { PRINT_CONTENT_WIDTH_PX, measureBodyHeight, printJobDescription } from "../lib/printing";
import { BUILD } from "../config";

function addresses(list: Address[]): string {
  if (list.length === 0) return "—";
  return list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}

/**
 * One message, prepared for paper.
 *
 * The body keeps the same fully-sandboxed frame it has on screen -- that frame
 * is a security boundary around untrusted third-party HTML, and dissolving it
 * so the page would paginate would be trading a real protection for a
 * convenience. What changes for print is only its height: an iframe is a
 * replaced element, so the browser paginates the box we give it and clips
 * anything the box does not cover. Give it the height of its own content and
 * the whole message flows across as many pages as it needs.
 */
function PrintMessage({ message, onMeasured }: {
  message: Message;
  onMeasured: (id: string, height: number) => void;
}) {
  const srcDoc = useMemo(() => {
    if (!message.html) return null;
    const { html } = sanitizeMessageHtml(message.html, message.attachments);
    // Light mode: this is going on paper, and the on-screen dark theme would
    // print as a solid black rectangle or, with backgrounds off, as pale grey
    // text on white.
    return buildIframeDocument(html, false);
  }, [message]);

  const [height, setHeight] = useState<number | null>(null);
  const measured = useRef<string | null>(null);

  useEffect(() => {
    if (!srcDoc) {
      onMeasured(message.id, 0);
      return;
    }
    if (measured.current === message.id) return;
    measured.current = message.id;
    let live = true;
    void measureBodyHeight(srcDoc).then((h) => {
      if (!live) return;
      setHeight(h);
      onMeasured(message.id, h);
    });
    return () => {
      live = false;
    };
  }, [srcDoc, message.id, onMeasured]);

  const files = message.attachments.filter((a) => !a.inline);

  return (
    <article className="printmsg">
      {/* Every printed message carries its own headers. A page pulled out of a
          bundle has to say what it is without the pages around it. */}
      <header className="printmsg-head">
        <h2>{message.subject || "(no subject)"}</h2>
        <dl>
          <dt>From</dt>
          <dd>{message.from ? addresses([message.from]) : "—"}</dd>
          {message.sender && (
            <>
              <dt>Sent by</dt>
              <dd>{addresses([message.sender])} on behalf of the sender above</dd>
            </>
          )}
          <dt>To</dt>
          <dd>{addresses(message.to)}</dd>
          {message.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{addresses(message.cc)}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>{message.date ? message.date.toLocaleString() : "—"}</dd>
          {files.length > 0 && (
            <>
              <dt>Attached</dt>
              <dd>{files.map((a) => a.filename).join(", ")}</dd>
            </>
          )}
        </dl>
      </header>

      <div className="printmsg-body">
        {srcDoc ? (
          <iframe
            title={`Printed message: ${message.subject || "(no subject)"}`}
            // Identical to the on-screen frame. Printing does not get its own,
            // more relaxed sandbox.
            sandbox=""
            srcDoc={srcDoc}
            style={{ height: height === null ? undefined : `${height}px` }}
          />
        ) : message.text ? (
          <pre>{message.text}</pre>
        ) : (
          <p className="printmsg-empty">This message has no readable body.</p>
        )}
      </div>
    </article>
  );
}

/**
 * The document that gets printed.
 *
 * Rather than trying to unpick the viewer's own layout for paper -- three
 * scrolling panes inside a `calc(100vh - 57px)` grid, which is what clipped
 * printing to a single page in the first place -- this is a separate, plain,
 * top-to-bottom document. It is rendered off-screen at print width at all
 * times, which is what makes Cmd-P work: the frames are already loaded and
 * already measured by the time the browser asks for a page, and no code has to
 * run during `beforeprint` to make it come out right.
 */
export default function PrintOut({ messages, listedCount, onReady }: {
  messages: Message[];
  listedCount: number;
  onReady: () => void;
}) {
  const [heights, setHeights] = useState<Record<string, number>>({});

  const onMeasured = useMemo(
    () => (id: string, height: number) => setHeights((prev) => (id in prev ? prev : { ...prev, [id]: height })),
    [],
  );

  const ids = messages.map((m) => m.id).join("|");
  const ready = messages.length > 0 && messages.every((m) => m.id in heights);

  useEffect(() => {
    if (ready) onReady();
  }, [ready, ids, onReady]);

  if (messages.length === 0) return null;

  return (
    <div className="printout" style={{ width: PRINT_CONTENT_WIDTH_PX }} aria-hidden="true">
      <div className="printout-head">
        <strong>mailviewer</strong>
        <span>
          {messages.length > 1 ? printJobDescription(listedCount, messages.length) : ""}
          {` Build ${BUILD.version} (${BUILD.commit}). Printed ${new Date().toLocaleString()}.`}
        </span>
      </div>
      {messages.map((m) => (
        <PrintMessage key={m.id} message={m} onMeasured={onMeasured} />
      ))}
    </div>
  );
}
