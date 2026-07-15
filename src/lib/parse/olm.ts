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
 * Two things about this format are genuinely under-specified, so both are done
 * defensively rather than assumed (see the comments at each site):
 *   - the exact directory layout, which has drifted across Outlook versions, and
 *   - where in the ZIP an attachment's bytes actually sit.
 *
 * The whole value of an archive format is its folder tree, so this reconstructs
 * a real nested Folder hierarchy from the entry paths rather than flattening.
 *
 * Runs in a Web Worker: DOMParser and fflate are both available there. No Node
 * APIs, no network.
 */
import { unzip } from "fflate";
import type {
  Address,
  Attachment,
  Folder,
  Message,
  ParsedArchive,
  ProgressFn,
} from "../model.ts";

type Entries = Record<string, Uint8Array>;

function unzipAsync(bytes: Uint8Array): Promise<Entries> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** First descendant element with the given tag name, or null. */
function child(el: Element | Document, tag: string): Element | null {
  return el.getElementsByTagName(tag)[0] ?? null;
}

/** Trimmed text content of the first `tag` under `el`, or undefined. */
function text(el: Element | Document, tag: string): string | undefined {
  const found = child(el, tag);
  const value = found?.textContent?.trim();
  return value ? value : undefined;
}

/** Read an attribute whose name matches `pattern`, case-insensitively. */
function attr(el: Element, pattern: RegExp): string | undefined {
  for (const a of Array.from(el.attributes)) {
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
function addresses(el: Element | null): Address[] {
  if (!el) return [];
  const nodes = el.getElementsByTagName("emailAddress");
  const list = nodes.length ? Array.from(nodes) : [el];
  const out: Address[] = [];
  for (const node of list) {
    const email = attr(node, /EmailAddressAddress$/i) ?? attr(node, /Address$/i);
    if (!email) continue;
    const name = attr(node, /EmailAddressName$/i) ?? attr(node, /Name$/i);
    out.push({ email, name: name || undefined });
  }
  return out;
}

function firstAddress(el: Element | null): Address | undefined {
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
function folderPathFor(entryPath: string): string[] {
  const segs = entryPath.split("/").filter(Boolean);
  const msgIdx = segs.findIndex((s) => /^messages?$/i.test(s));
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
function resolveAttachment(entries: Entries, url: string): Uint8Array | undefined {
  const candidates = new Set<string>([url, url.replace(/^\/+/, "")]);
  try {
    candidates.add(decodeURIComponent(url));
    candidates.add(decodeURIComponent(url).replace(/^\/+/, ""));
  } catch {
    // A malformed %-escape: the raw candidates above still stand.
  }

  for (const key of candidates) {
    if (entries[key]) return entries[key];
  }

  const keys = Object.keys(entries);
  const norm = url.replace(/^\/+/, "").toLowerCase();
  const bySuffix = keys.find((k) => k.toLowerCase().endsWith(norm));
  if (bySuffix) return entries[bySuffix];

  const base = norm.split("/").pop();
  if (base) {
    const byBase = keys.find((k) => k.toLowerCase().endsWith(`/${base}`) || k.toLowerCase() === base);
    if (byBase) return entries[byBase];
  }

  return undefined;
}

function extractAttachments(
  email: Element,
  entries: Entries,
  id: string,
  warnings: string[],
): Attachment[] {
  const list = child(email, "OPFMessageCopyAttachmentList");
  if (!list) return [];

  const out: Attachment[] = [];
  const nodes = list.getElementsByTagName("messageAttachment");
  Array.from(nodes).forEach((node, i) => {
    const url = attr(node, /^OPFAttachmentURL$/i) ?? attr(node, /URL$/i);
    const name = attr(node, /^OPFAttachmentName$/i) ?? attr(node, /Name$/i) ?? `attachment-${i + 1}`;
    const mime =
      attr(node, /^OPFAttachmentContentType$/i) ?? attr(node, /ContentType$/i) ?? "application/octet-stream";
    const cid = attr(node, /ContentID$/i)?.replace(/^<|>$/g, "");

    // Some rows are inline placeholders with no URL; skip them silently.
    if (!url) return;

    const content = resolveAttachment(entries, url);
    if (!content) {
      warnings.push(`Attachment "${name}" referenced ${url}, which is not in the archive.`);
      return;
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
  });

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

function buildMessage(
  email: Element,
  entries: Entries,
  id: string,
  folderPath: string[],
  rawXml: Uint8Array,
  warnings: string[],
): Message {
  const attachments = extractAttachments(email, entries, id, warnings);

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
// Entry point
// ---------------------------------------------------------------------------

export async function parseOlm(
  file: Blob,
  name: string,
  onProgress?: ProgressFn,
): Promise<ParsedArchive> {
  const warnings: string[] = [];

  onProgress?.({ phase: "Unpacking archive", fraction: 0, messagesFound: 0 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await unzipAsync(bytes);

  // Message XML files live under a "Message" segment. Discover them by shape
  // rather than by a fixed path, since the layout drifts between versions.
  const xmlKeys = Object.keys(entries).filter(
    (k) => /\.xml$/i.test(k) && /\/messages?\//i.test(`/${k}`),
  );

  const parser = new DOMParser();
  const messages: Message[] = [];
  const placed: Array<{ path: string[]; id: string }> = [];

  for (let i = 0; i < xmlKeys.length; i++) {
    const key = xmlKeys[i];
    const rawXml = entries[key];
    let doc: Document;
    try {
      doc = parser.parseFromString(new TextDecoder("utf-8").decode(rawXml), "application/xml");
    } catch {
      warnings.push(`Could not read XML at ${key}.`);
      continue;
    }
    if (doc.getElementsByTagName("parsererror").length > 0) {
      warnings.push(`Malformed XML at ${key}; skipped.`);
      continue;
    }

    // One XML file can hold one or several <email> elements.
    const emails = Array.from(doc.getElementsByTagName("email"));
    if (emails.length === 0) continue;

    const folderPath = folderPathFor(key);
    emails.forEach((email, j) => {
      const id = `msg-${messages.length}`;
      try {
        const message = buildMessage(email, entries, id, folderPath, rawXml, warnings);
        messages.push(message);
        placed.push({ path: folderPath, id });
      } catch (err) {
        warnings.push(
          `Skipped a message in ${key} (#${j + 1}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    if (i % 25 === 0 || i === xmlKeys.length - 1) {
      onProgress?.({
        phase: "Reading messages",
        fraction: xmlKeys.length ? (i + 1) / xmlKeys.length : null,
        messagesFound: messages.length,
      });
    }
  }

  if (messages.length === 0 && xmlKeys.length === 0) {
    throw new Error(
      "No messages found: this .olm archive has no message XML under a Message folder.",
    );
  }

  const root = buildFolderTree(name, placed);

  onProgress?.({ phase: "Done", fraction: 1, messagesFound: messages.length });

  return { sourceName: name, format: "olm", messages, root, warnings };
}
