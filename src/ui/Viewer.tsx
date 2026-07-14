import { useCallback, useMemo, useRef, useState } from "react";
import type { Folder, Message, ParsedArchive, ParseProgress } from "../lib/model";
import { parseFile } from "../lib/parseClient";
import MessageView from "./MessageView";

function flattenFolders(f: Folder, depth = 0): Array<{ folder: Folder; depth: number }> {
  return [{ folder: f, depth }, ...f.children.flatMap((c) => flattenFolders(c, depth + 1))];
}

function formatDate(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export default function Viewer() {
  const [archive, setArchive] = useState<ParsedArchive | null>(null);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (file: File) => {
    setError(null);
    setArchive(null);
    setMessageId(null);
    setProgress({ phase: "Opening", fraction: null, messagesFound: 0 });

    try {
      const { promise } = parseFile(file, setProgress);
      const result = await promise;
      setArchive(result);
      setFolderId(result.root.id);
      setMessageId(result.messages[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  }, []);

  const folders = useMemo(
    () => (archive ? flattenFolders(archive.root) : []),
    [archive],
  );

  const byId = useMemo(() => {
    const m = new Map<string, Message>();
    for (const msg of archive?.messages ?? []) m.set(msg.id, msg);
    return m;
  }, [archive]);

  const visible = useMemo(() => {
    if (!archive) return [];
    const folder = folders.find((f) => f.folder.id === folderId)?.folder ?? archive.root;

    // A folder shows its own messages plus everything beneath it, which is what
    // people expect when they click a parent in a mail client.
    const ids = new Set<string>();
    for (const { folder: f } of flattenFolders(folder)) {
      for (const id of f.messageIds) ids.add(id);
    }

    let list = [...ids].map((id) => byId.get(id)).filter((m): m is Message => !!m);

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => {
        const haystack = [
          m.subject,
          m.from?.name,
          m.from?.email,
          ...m.to.map((t) => t.email),
          m.text?.slice(0, 4000),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return list.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
  }, [archive, folders, folderId, byId, query]);

  const selected = messageId ? byId.get(messageId) ?? null : null;

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void load(file);
  }

  if (!archive) {
    return (
      <section className="section section-narrow" style={{ width: "100%" }}>
        <h2>Open</h2>
        <h3>Choose a mail file</h3>
        <p>
          It is read by JavaScript in this tab. It is not uploaded — open DevTools and watch
          the Network panel stay silent while you do this.
        </p>

        <div
          className={`dropzone ${dragOver ? "over" : ""}`}
          style={{ marginTop: 26 }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <h3>Drop a file here</h3>
          <p>.eml · .emlx · .msg · .mbox · .pst · .ost</p>

          <input
            ref={inputRef}
            type="file"
            hidden
            accept=".eml,.emlx,.msg,.mbox,.mbx,.pst,.ost,message/rfc822"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void load(f);
            }}
          />

          <button
            className="btn btn-primary"
            onClick={() => inputRef.current?.click()}
            disabled={!!progress}
          >
            Choose a file
          </button>

          {progress && (
            <div className="progress">
              <div>
                {progress.phase}
                {progress.messagesFound > 0 && ` · ${progress.messagesFound.toLocaleString()} messages`}
              </div>
              <div className={`bar ${progress.fraction === null ? "indet" : ""}`}>
                <i style={progress.fraction !== null ? { width: `${progress.fraction * 100}%` } : undefined} />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="callout bad">
            <strong>Couldn't open that file.</strong> {error}
          </div>
        )}
      </section>
    );
  }

  return (
    <>
      {archive.warnings.length > 0 && (
        <div className="warnbar">
          Opened with {archive.warnings.length.toLocaleString()}{" "}
          {archive.warnings.length === 1 ? "problem" : "problems"} — some messages in this
          archive are damaged and were skipped. The rest are shown below.
        </div>
      )}

      <div className="viewer">
        <aside className="pane">
          <div className="pane-head">Folders</div>
          {folders.map(({ folder, depth }) => (
            <button
              key={folder.id}
              className={`folder ${folder.id === folderId ? "active" : ""}`}
              style={{ paddingLeft: 14 + depth * 14 }}
              onClick={() => {
                setFolderId(folder.id);
                setMessageId(null);
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {folder.name}
              </span>
              <span className="folder-count">{folder.messageIds.length || ""}</span>
            </button>
          ))}
        </aside>

        <section className="pane">
          <div className="pane-head">
            <input
              className="search"
              type="search"
              placeholder="Search these messages…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {visible.length === 0 && (
            <div className="empty">
              {query ? "No messages match that search." : "This folder is empty."}
            </div>
          )}

          {visible.map((m) => (
            <button
              key={m.id}
              className={`msgrow ${m.id === messageId ? "active" : ""}`}
              onClick={() => setMessageId(m.id)}
            >
              <div className="msgrow-top">
                <span className="msgrow-from">
                  {m.from?.name || m.from?.email || "(unknown sender)"}
                </span>
                <span className="msgrow-date">{formatDate(m.date)}</span>
              </div>
              <div className="msgrow-subject">
                {m.subject}
                {m.flags.hasAttachments && <span className="msgrow-clip">◍</span>}
              </div>
            </button>
          ))}
        </section>

        <main className="pane">
          {selected ? (
            <MessageView message={selected} />
          ) : (
            <div className="empty">Select a message.</div>
          )}
        </main>
      </div>
    </>
  );
}
