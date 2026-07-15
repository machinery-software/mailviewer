import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Folder, Message, ParseProgress, ParsedArchive } from "../lib/model";
import { parseFile } from "../lib/parseClient";
import { namespaceArchive } from "../lib/combine";
import { takePendingFiles } from "../lib/pendingFiles";
import { highlight } from "../lib/highlight";
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

const ACCEPT = ".eml,.emlx,.msg,.oft,.mbox,.mbx,.pst,.ost,.olm,.mht,.mhtml,message/rfc822";

interface FileError {
  name: string;
  message: string;
}

export default function Viewer() {
  // Every opened file becomes one archive, id-namespaced so they can share a
  // view. Files accumulate -- opening a second one adds to the first.
  const [archives, setArchives] = useState<ParsedArchive[]>([]);
  const [progress, setProgress] = useState<ParseProgress | null>(null);
  const [progressName, setProgressName] = useState<string>("");
  const [errors, setErrors] = useState<FileError[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const busy = useRef(false);

  const loadFiles = useCallback(async (files: File[]) => {
    if (busy.current || files.length === 0) return;
    busy.current = true;
    setErrors([]);

    for (const file of files) {
      setProgressName(file.name);
      setProgress({ phase: "Opening", fraction: null, messagesFound: 0 });
      try {
        const { promise } = parseFile(file, setProgress);
        const result = await promise;
        const key = `f${nextKey.current++}`;
        const ns = namespaceArchive(result, key);
        setArchives((prev) => [...prev, ns]);
        // Jump to the file we just opened, so a drop always shows its result.
        setFolderId(ns.root.id);
        setMessageId(ns.messages[0]?.id ?? null);
      } catch (err) {
        setErrors((prev) => [
          ...prev,
          { name: file.name, message: err instanceof Error ? err.message : String(err) },
        ]);
      }
    }

    setProgress(null);
    busy.current = false;
  }, []);

  // Files chosen on the landing hero are handed over here on first mount.
  useEffect(() => {
    const pending = takePendingFiles();
    if (pending.length) void loadFiles(pending);
  }, [loadFiles]);

  const folders = useMemo(
    () => archives.flatMap((a) => flattenFolders(a.root)),
    [archives],
  );

  const byId = useMemo(() => {
    const m = new Map<string, Message>();
    for (const a of archives) for (const msg of a.messages) m.set(msg.id, msg);
    return m;
  }, [archives]);

  const warningCount = useMemo(
    () => archives.reduce((n, a) => n + a.warnings.length, 0),
    [archives],
  );

  const visible = useMemo(() => {
    // folderId null means "everything, across every open file".
    let ids: Iterable<string>;
    if (folderId === null) {
      ids = byId.keys();
    } else {
      const folder = folders.find((f) => f.folder.id === folderId)?.folder;
      if (!folder) return [];
      const set = new Set<string>();
      // A folder shows its own messages plus everything beneath it.
      for (const { folder: f } of flattenFolders(folder)) {
        for (const id of f.messageIds) set.add(id);
      }
      ids = set;
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
  }, [folders, folderId, byId, query]);

  const selected = messageId ? byId.get(messageId) ?? null : null;

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = [...e.dataTransfer.files];
      if (files.length) void loadFiles(files);
    },
    [loadFiles],
  );

  const pickFiles = () => inputRef.current?.click();

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      hidden
      multiple
      accept={ACCEPT}
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        // Reset so re-choosing the same file still fires a change event.
        e.target.value = "";
        if (files.length) void loadFiles(files);
      }}
    />
  );

  const progressBlock = progress && (
    <div className="progress">
      <div>
        Opening {progressName} · {progress.phase}
        {progress.messagesFound > 0 && ` · ${progress.messagesFound.toLocaleString()} messages`}
      </div>
      <div className={`bar ${progress.fraction === null ? "indet" : ""}`}>
        <i style={progress.fraction !== null ? { width: `${progress.fraction * 100}%` } : undefined} />
      </div>
    </div>
  );

  // ---- empty state: the first-file dropzone --------------------------------
  if (archives.length === 0) {
    return (
      <section className="section section-narrow" style={{ width: "100%" }}>
        <h2>Open</h2>
        <h3>Choose a mail file</h3>
        <p>
          It's read by JavaScript in this tab and never uploaded. You can open several files —
          each one is added to the list, so you can read across all of them at once.
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
          <h3>Drop files here</h3>
          <p>.eml · .emlx · .msg · .oft · .mbox · .pst · .ost · .olm · .mht</p>
          {hiddenInput}
          <button className="btn btn-primary" onClick={pickFiles} disabled={!!progress}>
            Choose files
          </button>
          {progressBlock}
        </div>

        {errors.length > 0 && (
          <div className="callout bad">
            <strong>Couldn't open {errors.length === 1 ? "that file" : "some files"}.</strong>
            <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
              {errors.map((e, i) => (
                <li key={i}>
                  {e.name}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    );
  }

  // ---- loaded state: the three-pane viewer ---------------------------------
  const showAllRow = archives.length > 1;

  return (
    <div
      className={`viewer-wrap ${dragOver ? "drop-target" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only clear when the cursor actually leaves the wrapper, not on every
        // child boundary crossed on the way across the pane.
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {(warningCount > 0 || errors.length > 0) && (
        <div className="warnbar">
          {warningCount > 0 && (
            <>
              Opened with {warningCount.toLocaleString()}{" "}
              {warningCount === 1 ? "problem" : "problems"} — some messages were damaged and
              skipped.{" "}
            </>
          )}
          {errors.map((e) => `${e.name} could not be opened.`).join(" ")}
        </div>
      )}

      <div className="viewer">
        <aside className="pane">
          <div className="pane-head">
            <span>Files</span>
            {hiddenInput}
            <button className="pane-add" onClick={pickFiles} title="Open more files" disabled={!!progress}>
              ＋ Add
            </button>
          </div>

          {progress && <div className="pane-progress">Opening {progressName}…</div>}

          {showAllRow && (
            <button
              className={`folder ${folderId === null ? "active" : ""}`}
              onClick={() => {
                setFolderId(null);
                setMessageId(null);
              }}
            >
              <span>All messages</span>
              <span className="folder-count">{byId.size}</span>
            </button>
          )}

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
                  {highlight(m.from?.name || m.from?.email || "(unknown sender)", query)}
                </span>
                <span className="msgrow-date">{formatDate(m.date)}</span>
              </div>
              <div className="msgrow-subject">
                {highlight(m.subject, query)}
                {m.flags.hasAttachments && <span className="msgrow-clip">◍</span>}
              </div>
            </button>
          ))}
        </section>

        <main className="pane">
          {selected ? (
            <MessageView message={selected} query={query} />
          ) : (
            <div className="empty">Select a message.</div>
          )}
        </main>
      </div>

      {dragOver && <div className="drop-hint">Drop to add more files</div>}
    </div>
  );
}
