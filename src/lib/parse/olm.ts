/**
 * Outlook for Mac archive (.olm) reader.
 *
 * An .olm is a ZIP. Inside, each message is an XML file living under a path that
 * encodes the folder it belonged to:
 *
 *   Accounts/<account>/Message/<folder>/<subfolder>/<bucket>/<hash>.xml
 *
 * The message XML uses Outlook-for-Mac's `OPF*` element vocabulary, and its
 * bodies are XML-escaped. Attachments are declared inside the XML but their
 * bytes live as separate ZIP entries, referenced by an `OPFAttachmentURL` path.
 *
 * Outlook 2016 and later name the message directory "com.microsoft.__Messages"
 * rather than "Message":
 *
 *   Accounts/<account>/com.microsoft.__Messages/<folder>/message_00000.xml
 *
 * Two things about this format are genuinely under-specified, so both are done
 * defensively rather than assumed (see the comments at each site):
 *   - the exact directory layout, which has drifted across Outlook versions, and
 *   - where in the ZIP an attachment's bytes actually sit.
 *
 * The whole value of an archive format is its folder tree, so this reconstructs
 * a real nested Folder hierarchy from the entry paths rather than flattening.
 *
 * Runs where the parsers run: the browser's parse Web Worker, and the Mac app's
 * parse service on bare JavaScriptCore. Neither has DOMParser, document or
 * window, so the XML is read by ./xml.ts and the ZIP by ./zip.ts, both plain
 * ECMAScript. An earlier version called DOMParser, passed its tests in jsdom,
 * and failed on every real .olm (MAC-513). No Node APIs, no network.
 *
 * The ZIP is never unzipped whole: the archive's index is read first, then one
 * message's XML at a time, and an attachment's bytes only when a message names
 * them.
 */
import { descendants, firstDescendant, parseXml, textContent, XmlError } from "./xml.ts";
import type { XmlElement } from "./xml.ts";
import { readZipEntry, readZipIndex, ZipError } from "./zip.ts";
import type { ZipEntry } from "./zip.ts";
import type {
  Address,
  Attachment,
  Folder,
  Message,
  ParsedArchive,
  ProgressFn,
} from "../model.ts";

/** The archive's index, and a way to read any one entry from it on demand. */
export interface OlmIndex {
  file: Blob;
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** The entries that hold message XML, in archive order. */
  messageEntries: ZipEntry[];
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** First descendant element with the given tag name, or null. */
function child(el: XmlElement, tag: string): XmlElement | null {
  return firstDescendant(el, tag);
}

/** Trimmed text content of the first `tag` under `el`, or undefined. */
function text(el: XmlElement, tag: string): string | undefined {
  const found = child(el, tag);
  const value = found ? textContent(found).trim() : "";
  return value ? value : undefined;
}

/** Read an attribute whose name matches `pattern`, case-insensitively. */
function attr(el: XmlElement, pattern: RegExp): string | undefined {
  for (const a of el.attributes) {
    if (pattern.test(a.name)) {
      const v = a.value.trim();
      if (v) return v;
    }
  }
  return undefined;
}

/**
 * Addresses out of an OLM container element. OLM wraps each address in an
 * `<emailAddress>` element carrying `OPFContactEmailAddressAddress` and
 * `OPFContactEmailAddressName` attributes. Falls back to any attribute whose
 * name ends in "Address"/"Name" so a version that spells them differently still
 * yields something.
 */
function addresses(el: XmlElement | null): Address[] {
  if (!el) return [];
  const nodes = descendants(el, "emailAddress");
  const list = nodes.length ? nodes : [el];
  const out: Address[] = [];
  for (const node of list) {
    const email = attr(node, /EmailAddressAddress$/i) ?? attr(node, /Address$/i);
    if (!email) continue;
    const name = attr(node, /EmailAddressName$/i) ?? attr(node, /Name$/i);
    out.push({ email, name: name || undefined });
  }
  return out;
}

function firstAddress(el: XmlElement | null): Address | undefined {
  return addresses(el)[0];
}

// ---------------------------------------------------------------------------
// Folder path
// ---------------------------------------------------------------------------

/**
 * Derive the folder path a message belonged to from its ZIP entry path.
 *
 * Everything after the "Message" segment and before the filename is folder
 * hierarchy -- except the archive drops each message into a short hash-bucket
 * directory (e.g. "1a"), which is storage plumbing, not a folder the user made.
 * We strip a trailing 1-2 character hex bucket. A real folder literally named
 * "1a" would be misread, which is the documented risk of a format with no
 * manifest; every other case is handled correctly.
 */
const MESSAGES_DIR = /^(?:messages?|com\.microsoft\.__messages)$/i;
const ATTACHMENTS_DIR = /^(?:attachments?|com\.microsoft\.__attachments)$/i;

/**
 * Is this entry a message's XML? It is an .xml under a message directory and
 * not under an attachments directory -- an attached .xml file is not a message.
 */
function isMessageEntry(entryPath: string): boolean {
  if (!/\.xml$/i.test(entryPath)) return false;
  const segs = entryPath.split("/").filter(Boolean).slice(0, -1);
  const msgIdx = segs.findIndex((s) => MESSAGES_DIR.test(s));
  return msgIdx !== -1 && !segs.slice(msgIdx + 1).some((s) => ATTACHMENTS_DIR.test(s));
}

function folderPathFor(entryPath: string): string[] {
  const segs = entryPath.split("/").filter(Boolean);
  const msgIdx = segs.findIndex((s) => MESSAGES_DIR.test(s));
  const rel = msgIdx === -1 ? segs.slice(0, -1) : segs.slice(msgIdx + 1, -1);
  if (rel.length && /^[0-9a-f]{1,2}$/i.test(rel[rel.length - 1])) rel.pop();
  return rel;
}

// ---------------------------------------------------------------------------
// Attachment resolution
// ---------------------------------------------------------------------------

/**
 * Find an attachment's bytes in the ZIP. `OPFAttachmentURL` is a path into the
 * archive, but it may be absolute, relative, or URL-encoded, and its casing may
 * not match the entry table. Try the obvious keys, then fall back to matching by
 * suffix and finally by basename.
 */
function resolveAttachment(index: OlmIndex, url: string): ZipEntry | undefined {
  const candidates = new Set<string>([url, url.replace(/^\/+/, "")]);
  try {
    candidates.add(decodeURIComponent(url));
    candidates.add(decodeURIComponent(url).replace(/^\/+/, ""));
  } catch {
    // A malformed %-escape: the raw candidates above still stand.
  }

  for (const key of candidates) {
    const hit = index.byName.get(key);
    if (hit) return hit;
  }

  const norm = url.replace(/^\/+/, "").toLowerCase();
  const bySuffix = index.entries.find((e) => e.name.toLowerCase().endsWith(norm));
  if (bySuffix) return bySuffix;

  const base = norm.split("/").pop();
  if (base) {
    const byBase = index.entries.find(
      (e) => e.name.toLowerCase().endsWith(`/${base}`) || e.name.toLowerCase() === base,
    );
    if (byBase) return byBase;
  }

  return undefined;
}

async function extractAttachments(
  email: XmlElement,
  index: OlmIndex,
  id: string,
  warnings: string[],
): Promise<Attachment[]> {
  const list = child(email, "OPFMessageCopyAttachmentList");
  if (!list) return [];

  const out: Attachment[] = [];
  const nodes = descendants(list, "messageAttachment");
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const url = attr(node, /^OPFAttachmentURL$/i) ?? attr(node, /URL$/i);
    const name = attr(node, /^OPFAttachmentName$/i) ?? attr(node, /Name$/i) ?? `attachment-${i + 1}`;
    const mime =
      attr(node, /^OPFAttachmentContentType$/i) ?? attr(node, /ContentType$/i) ?? "application/octet-stream";
    const cid = attr(node, /ContentID$/i)?.replace(/^<|>$/g, "");

    // Some rows are inline placeholders with no URL; skip them silently.
    if (!url) continue;

    const entry = resolveAttachment(index, url);
    if (!entry) {
      warnings.push(`Attachment "${name}" referenced ${url}, which is not in the archive.`);
      continue;
    }
    let content: Uint8Array;
    try {
      content = await readZipEntry(index.file, entry);
    } catch (err) {
      warnings.push(`Attachment "${name}" could not be read: ${errText(err)}`);
      continue;
    }

    out.push({
      id: `${id}:att:${i}`,
      filename: name,
      mimeType: mime,
      size: content.byteLength,
      contentId: cid,
      contentLocation: undefined,
      inline: !!cid && /^image\//i.test(mime),
      content,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function buildMessage(
  email: XmlElement,
  index: OlmIndex,
  id: string,
  folderPath: string[],
  rawXml: Uint8Array,
  warnings: string[],
): Promise<Message> {
  const attachments = await extractAttachments(email, index, id, warnings);

  const from =
    firstAddress(child(email, "OPFMessageCopyFromAddresses")) ??
    firstAddress(child(email, "OPFMessageCopyFrom")) ??
    firstAddress(child(email, "OPFMessageCopySenderAddress"));

  // The submitting sender, when it differs from the authored From.
  const senderEl =
    child(email, "OPFMessageCopySenderAddress") ?? child(email, "OPFMessageCopySender");
  let sender = firstAddress(senderEl);
  if (sender && from && sender.email.toLowerCase() === from.email.toLowerCase()) {
    sender = undefined;
  }

  const messageId = text(email, "OPFMessageCopyMessageID");
  const html = text(email, "OPFMessageCopyHTMLBody");
  const body = text(email, "OPFMessageCopyBody");

  return {
    id,
    format: "olm",
    subject: text(email, "OPFMessageCopySubject") || "(no subject)",
    from,
    sender,
    replyTo: addresses(child(email, "OPFMessageCopyReplyToAddresses")),
    to: addresses(child(email, "OPFMessageCopyToAddresses")),
    cc: addresses(child(email, "OPFMessageCopyCCAddresses")),
    bcc: addresses(child(email, "OPFMessageCopyBCCAddresses")),
    date:
      parseDate(text(email, "OPFMessageCopySentTime")) ??
      parseDate(text(email, "OPFMessageCopyReceivedTime")),
    messageId,
    references: [],
    html,
    text: body,
    attachments,
    headers: [],
    raw: rawXml,
    folderPath,
    flags: {
      hasAttachments: attachments.some((a) => !a.inline),
    },
  };
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------

function buildFolderTree(
  rootName: string,
  placed: Array<{ path: string[]; id: string }>,
): Folder {
  const root: Folder = { id: "root", name: rootName, path: [rootName], children: [], messageIds: [] };

  const find = (parent: Folder, name: string, path: string[]): Folder => {
    let node = parent.children.find((c) => c.name === name);
    if (!node) {
      node = { id: `folder:${path.join("/")}`, name, path, children: [], messageIds: [] };
      parent.children.push(node);
    }
    return node;
  };

  for (const { path, id } of placed) {
    let node = root;
    const acc: string[] = [];
    for (const seg of path) {
      acc.push(seg);
      node = find(node, seg, [...acc]);
    }
    node.messageIds.push(id);
  }

  // Stable, human order in each folder's children.
  const sortTree = (f: Folder) => {
    f.children.sort((a, b) => a.name.localeCompare(b.name));
    f.children.forEach(sortTree);
  };
  sortTree(root);

  return root;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const utf8 = new TextDecoder("utf-8");

/**
 * Read the archive's index: every entry's name, size and position, and which
 * of them are messages. Reads only the end of the file.
 */
export async function openOlm(file: Blob): Promise<OlmIndex> {
  let entries: ZipEntry[];
  try {
    entries = await readZipIndex(file);
  } catch (err) {
    if (!(err instanceof ZipError)) throw err;
    throw new Error(
      `This .olm is incomplete or damaged (${err.message.charAt(0).toLowerCase()}${err.message.slice(1)}). ` +
        "A file cut short while copying or downloading looks like this. Copy it again from the Mac " +
        "that exported it, or export it again from Outlook (File > Export).",
    );
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Message XML files live under a message directory. Discover them by shape
  // rather than by a fixed path, since the layout drifts between versions.
  const messageEntries = entries.filter((e) => isMessageEntry(e.name));
  return { file, entries, byName, messageEntries };
}

/**
 * Read the messages in one message entry. One XML file can hold one or several
 * <email> elements. `firstId` numbers them. Throws when the entry cannot be
 * read or is not well-formed XML; a damaged attachment is only a warning.
 */
export async function readOlmMessages(
  index: OlmIndex,
  entry: ZipEntry,
  firstId: number,
  warnings: string[],
): Promise<Message[]> {
  const rawXml = await readZipEntry(index.file, entry);
  let root: XmlElement;
  try {
    root = parseXml(utf8.decode(rawXml));
  } catch (err) {
    if (err instanceof XmlError) throw new Error(`Malformed XML at ${entry.name}: ${err.message}`);
    throw err;
  }
  const emails = root.name === "email" ? [root] : descendants(root, "email");
  const folderPath = folderPathFor(entry.name);
  const out: Message[] = [];
  for (let j = 0; j < emails.length; j++) {
    const id = `msg-${firstId + out.length}`;
    try {
      out.push(await buildMessage(emails[j], index, id, folderPath, rawXml, warnings));
    } catch (err) {
      warnings.push(`Skipped a message in ${entry.name} (#${j + 1}): ${errText(err)}`);
    }
  }
  return out;
}

export async function parseOlm(
  file: Blob,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  const warnings: string[] = [];

  onProgress?.({ phase: "Reading the archive's index", fraction: null, messagesFound: 0 });

  const index = await openOlm(file);
  const keys = index.messageEntries;

  if (keys.length === 0) {
    throw new Error(
      "No messages found: this .olm archive has no message XML under a Message folder.",
    );
  }

  const messages: Message[] = [];
  const placed: Array<{ path: string[]; id: string }> = [];
  let unreadable = 0;
  let firstProblem = "";

  for (let i = 0; i < keys.length; i++) {
    const entry = keys[i];
    try {
      const found = await readOlmMessages(index, entry, messages.length, warnings);
      for (const m of found) {
        messages.push(m);
        placed.push({ path: m.folderPath, id: m.id });
      }
    } catch (err) {
      unreadable++;
      const problem = err instanceof ZipError ? `Could not read ${entry.name}: ${err.message}` : errText(err);
      firstProblem ||= problem;
      warnings.push(`${problem}; skipped.`);
    }

    if (i % 25 === 0 || i === keys.length - 1) {
      onProgress?.({
        phase: "Reading messages",
        fraction: (i + 1) / keys.length,
        messagesFound: messages.length,
      });
    }
  }

  // Damage to some messages is a warning; damage to all of them is an archive
  // that did not open, and saying so beats an empty folder tree.
  if (messages.length === 0 && unreadable > 0) {
    throw new Error(
      `None of the ${unreadable.toLocaleString("en-US")} message ${unreadable === 1 ? "file" : "files"} ` +
        `in this .olm could be read. The first problem: ${firstProblem}`,
    );
  }

  const root = buildFolderTree(name, placed);

  onProgress?.({ phase: "Done", fraction: 1, messagesFound: messages.length });

  return { sourceName: name, format: "olm", messages, root, warnings };
}
