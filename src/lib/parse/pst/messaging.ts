/**
 * Messaging layer (MS-PST section 2.4): turning nodes into folders and
 * messages, and mapping MAPI properties onto the app's Message model.
 */
import type { Address, Attachment, Folder, Message } from "../../model.ts";
import type { Ndb, SubnodeEntry } from "./ndb.ts";
import { PropertyContext, TableContext, rowInt, rowString } from "./ltp.ts";
import { decompressLzfu } from "../lzfu.ts";
import { deencapsulateRtf } from "../rtf.ts";
import {
  ATTACH_EMBEDDED_MESSAGE,
  ATT_RENDERED_IN_BODY,
  MSGFLAG_READ,
  MSGFLAG_UNSENT,
  PidTagAddressType,
  PidTagAttachContentId,
  PidTagAttachDataBinary,
  PidTagAttachFilename,
  PidTagAttachFlags,
  PidTagAttachLongFilename,
  PidTagAttachMethod,
  PidTagAttachMimeTag,
  PidTagAttachSize,
  PidTagAttachmentHidden,
  PidTagBody,
  PidTagClientSubmitTime,
  PidTagCreationTime,
  PidTagDisplayBcc,
  PidTagDisplayCc,
  PidTagDisplayName,
  PidTagDisplayTo,
  PidTagEmailAddress,
  PidTagFlagStatus,
  PidTagHtml,
  PidTagInReplyToId,
  PidTagInternetMessageId,
  PidTagInternetReferences,
  PidTagMessageDeliveryTime,
  PidTagMessageFlags,
  PidTagRecipientDisplayName,
  PidTagRecipientType,
  PidTagRtfCompressed,
  PidTagSenderAddressType,
  PidTagSenderEmailAddress,
  PidTagSenderName,
  PidTagSenderSmtpAddress,
  PidTagSentRepresentingAddressType,
  PidTagSentRepresentingEmailAddress,
  PidTagSentRepresentingName,
  PidTagSentRepresentingSmtpAddress,
  PidTagSmtpAddress,
  PidTagSubject,
  PidTagTransportMessageHeaders,
  RECIP_BCC,
  RECIP_CC,
  codepageLabel,
  decodeText,
  decodeUtf16,
} from "./props.ts";
import type { ObjectRef, PropEntry } from "./props.ts";

// ---------------------------------------------------------------- NIDs

export const NID_ROOT_FOLDER = 0x122;
export const NID_MESSAGE_STORE = 0x21;
export const NID_NAME_TO_ID_MAP = 0x61;

const NID_TYPE_HIERARCHY_TABLE = 0x0d;
const NID_TYPE_CONTENTS_TABLE = 0x0e;

/** Well-known subnode NIDs that hang off every message. */
const NID_RECIPIENT_TABLE = 0x692;
const NID_ATTACHMENT_TABLE = 0x671;

function nidType(nid: number): number {
  return nid & 0x1f;
}

/** Sibling NID of the same object with a different type nibble. */
function siblingNid(nid: number, type: number): number {
  return ((nid & ~0x1f) | type) >>> 0;
}

// ---------------------------------------------------------------- helpers

/**
 * PidTagSubject can be prefixed with a two-character control sequence: 0x01
 * followed by a byte giving the length of the reply/forward prefix. The prefix
 * text itself ("RE: ", "FW: ") is real subject content and stays; only the two
 * control characters come off.
 */
export function stripSubjectPrefix(subject: string): string {
  if (subject.length >= 2 && subject.charCodeAt(0) === 0x01) {
    return subject.slice(2);
  }
  return subject;
}

function looksLikeSmtp(s: string | undefined): s is string {
  return !!s && s.includes("@") && !s.startsWith("/");
}

/**
 * Picks the best email address available.
 *
 * Exchange stores internal senders as X500 distinguished names
 * ("/O=CORP/OU=.../CN=RECIPIENTS/CN=ALICE"), which are useless to a reader. When
 * the address type is EX we go looking for the SMTP mirror property Outlook
 * caches alongside it; only if that is missing do we fall back to the X500
 * string, on the grounds that showing something beats showing nothing.
 */
function bestAddress(
  name: string | undefined,
  addrType: string | undefined,
  email: string | undefined,
  smtp: string | undefined,
): Address | undefined {
  let chosen: string | undefined;

  if (looksLikeSmtp(smtp)) chosen = smtp;
  else if (addrType?.toUpperCase() === "SMTP" && email) chosen = email;
  else if (looksLikeSmtp(email)) chosen = email;
  else chosen = smtp ?? email;

  if (!chosen && !name) return undefined;
  return { name: name || undefined, email: chosen ?? "" };
}

function sameAddress(a: Address | undefined, b: Address | undefined): boolean {
  if (!a || !b) return false;
  return a.email.toLowerCase() === b.email.toLowerCase() && (a.name ?? "") === (b.name ?? "");
}

/** Splits a PidTagDisplayTo-style semicolon list into name-only addresses. */
function displayListToAddresses(list: string | undefined): Address[] {
  if (!list) return [];
  return list
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (looksLikeSmtp(s) ? { email: s } : { name: s, email: "" }));
}

/** Unfolds and splits RFC822 headers, preserving order and duplicates. */
export function parseHeaderBlock(raw: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const lines = raw.split(/\r\n|\n|\r/);
  let current: { key: string; value: string } | null = null;

  for (const line of lines) {
    if (!line.length) {
      // A blank line ends the header block.
      if (current) {
        out.push(current);
        current = null;
      }
      break;
    }
    if (/^[ \t]/.test(line) && current) {
      current.value += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    if (current) out.push(current);
    current = { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  }
  if (current) out.push(current);
  return out;
}

function formatAddress(a: Address): string {
  if (a.name && a.email) return `${a.name} <${a.email}>`;
  return a.email || a.name || "";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + B64[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >>> 18) & 63]! + B64[(n >>> 12) & 63]! + B64[(n >>> 6) & 63]! + "=";
  }
  return out;
}

function wrap76(s: string): string {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += 76) parts.push(s.slice(i, i + 76));
  return parts.join("\r\n");
}

const utf8 = new TextEncoder();

/**
 * Serialises a parsed Message back to RFC822.
 *
 * Only used for embedded-message attachments (PidTagAttachMethod == 5). The
 * PST stores those as a nested property bag, not as bytes, so there is no
 * "original" to hand back -- and the Attachment model needs a byte payload for
 * the download button to mean anything. This produces a faithful-enough .eml
 * from what we parsed. It is a reconstruction, not the original wire format,
 * and it is only ever used for this one case.
 */
function serializeEml(msg: Message): Uint8Array {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const h of msg.headers) {
    lines.push(`${h.key}: ${h.value}`);
    seen.add(h.key.toLowerCase());
  }
  const add = (k: string, v: string | undefined) => {
    if (v && !seen.has(k.toLowerCase())) lines.push(`${k}: ${v}`);
  };
  add("Date", msg.date ? msg.date.toUTCString() : undefined);
  add("From", msg.from ? formatAddress(msg.from) : undefined);
  add("To", msg.to.map(formatAddress).join(", ") || undefined);
  add("Cc", msg.cc.map(formatAddress).join(", ") || undefined);
  add("Subject", msg.subject || undefined);
  add("Message-ID", msg.messageId);

  const boundary = "----=_pst_embedded_" + Math.abs(hashString(msg.id)).toString(36);
  const hasParts = msg.attachments.length > 0;

  if (hasParts) {
    lines.push("MIME-Version: 1.0");
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);
  }

  if (msg.html) {
    lines.push('Content-Type: text/html; charset="utf-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(wrap76(base64(utf8.encode(msg.html))));
  } else {
    lines.push('Content-Type: text/plain; charset="utf-8"');
    lines.push("Content-Transfer-Encoding: base64");
    lines.push("");
    lines.push(wrap76(base64(utf8.encode(msg.text ?? ""))));
  }

  for (const att of msg.attachments) {
    lines.push("");
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    lines.push("Content-Transfer-Encoding: base64");
    lines.push(`Content-Disposition: ${att.inline ? "inline" : "attachment"}; filename="${att.filename}"`);
    if (att.contentId) lines.push(`Content-ID: <${att.contentId}>`);
    lines.push("");
    lines.push(wrap76(base64(att.content)));
  }

  if (hasParts) {
    lines.push("");
    lines.push(`--${boundary}--`);
  }

  return utf8.encode(lines.join("\r\n"));
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 200) || "attachment";
}

// ---------------------------------------------------------------- context

export interface WalkContext {
  ndb: Ndb;
  warnings: string[];
  messages: Message[];
  /** propId -> {guid, name/id} for named properties, keyed by 0x8000+ ids. */
  namedProps: Map<number, NamedProp>;
  onCount?: (found: number) => void;
}

export interface NamedProp {
  propId: number;
  guid: string;
  /** Set for string-named properties. */
  name?: string;
  /** Set for numeric-named properties. */
  id?: number;
}

/**
 * Reads the name-to-ID map (NID 0x61).
 *
 * Named properties are how MAPI escapes the 16-bit tag space: an ID at or above
 * 0x8000 is a per-file alias whose real identity is a (GUID, name) pair. Without
 * this map those tags are meaningless across files. We surface the mapping so
 * callers can look up, e.g., the internet-headers namespace.
 */
export async function readNamedPropertyMap(ndb: Ndb, warnings: string[]): Promise<Map<number, NamedProp>> {
  const out = new Map<number, NamedProp>();
  try {
    const node = await ndb.lookupNode(NID_NAME_TO_ID_MAP);
    if (!node) return out;

    const subnodes = await ndb.readSubnodes(node.bidSub);
    const pc = await PropertyContext.load(ndb, node.bidData, subnodes);

    const entries = pc.getBinary(0x0003);
    const strings = pc.getBinary(0x0004);
    const guids = pc.getBinary(0x0002);
    if (!entries) return out;

    const view = entries;
    const count = Math.floor(view.length / 8);

    for (let i = 0; i < count; i++) {
      const off = i * 8;
      const dwPropId =
        (view[off]! | (view[off + 1]! << 8) | (view[off + 2]! << 16) | (view[off + 3]! << 24)) >>> 0;
      const wGuid = view[off + 4]! | (view[off + 5]! << 8);
      const wPropIdx = view[off + 6]! | (view[off + 7]! << 8);

      const isString = (wGuid & 0x0001) !== 0;
      const guidIndex = wGuid >>> 1;

      let guid = "";
      if (guidIndex === 1) guid = "PS_MAPI";
      else if (guidIndex === 2) guid = "PS_PUBLIC_STRINGS";
      else if (guidIndex >= 3 && guids) {
        const g = (guidIndex - 3) * 16;
        if (g + 16 <= guids.length) {
          guid = Array.from(guids.subarray(g, g + 16))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        }
      }

      const propId = 0x8000 + wPropIdx;

      if (isString && strings) {
        // dwPropId is a byte offset into the string stream: a uint32 length
        // followed by that many UTF-16LE bytes.
        if (dwPropId + 4 <= strings.length) {
          const len =
            (strings[dwPropId]! |
              (strings[dwPropId + 1]! << 8) |
              (strings[dwPropId + 2]! << 16) |
              (strings[dwPropId + 3]! << 24)) >>>
            0;
          const start = dwPropId + 4;
          if (len <= strings.length - start) {
            out.set(propId, {
              propId,
              guid,
              name: decodeUtf16(strings.subarray(start, start + len)),
            });
            continue;
          }
        }
        out.set(propId, { propId, guid });
      } else {
        out.set(propId, { propId, guid, id: dwPropId });
      }
    }
  } catch (err) {
    warnings.push(`Could not read the named-property map: ${errText(err)}`);
  }
  return out;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------- folders

export interface FolderPlan {
  nid: number;
  name: string;
  path: string[];
  messageNids: number[];
  children: FolderPlan[];
}

/**
 * First pass: builds the folder tree and collects message NIDs, without
 * touching a single message body.
 *
 * Cheap enough to run up front (a contents table's row-index BTH gives us the
 * message NIDs without reading the row matrix), and it means the progress bar
 * has a real denominator instead of crawling towards an unknown total.
 */
export async function planFolders(ctx: WalkContext, rootNid: number): Promise<FolderPlan> {
  const seen = new Set<number>();
  const plan = await planFolder(ctx, rootNid, [], seen, 0);
  return plan ?? { nid: rootNid, name: "", path: [], messageNids: [], children: [] };
}

async function planFolder(
  ctx: WalkContext,
  nid: number,
  parentPath: string[],
  seen: Set<number>,
  depth: number,
): Promise<FolderPlan | null> {
  if (depth > 64 || seen.has(nid)) return null;
  seen.add(nid);

  let name = "";
  try {
    const node = await ctx.ndb.lookupNode(nid);
    if (!node) return null;
    const subnodes = await ctx.ndb.readSubnodes(node.bidSub);
    const pc = await PropertyContext.load(ctx.ndb, node.bidData, subnodes);
    name = pc.getString(PidTagDisplayName) ?? "";
  } catch (err) {
    ctx.warnings.push(`Folder ${hex(nid)}: could not read its properties (${errText(err)}).`);
  }

  // The root folder has no useful display name; it is a container, not a folder.
  const path = depth === 0 ? [] : [...parentPath, name || `Folder ${hex(nid)}`];

  const messageNids = await readTableRowIds(ctx, siblingNid(nid, NID_TYPE_CONTENTS_TABLE), `contents of ${hex(nid)}`);
  const childNids = await readTableRowIds(ctx, siblingNid(nid, NID_TYPE_HIERARCHY_TABLE), `hierarchy of ${hex(nid)}`);

  const children: FolderPlan[] = [];
  for (const child of childNids) {
    // Guard against a hierarchy row that points at something that is not a folder.
    if (nidType(child) !== 0x02 && nidType(child) !== 0x03) continue;
    const sub = await planFolder(ctx, child, path, seen, depth + 1);
    if (sub) children.push(sub);
  }

  return { nid, name, path, messageNids, children };
}

/** Row IDs of a table node, or [] if the table is absent or unreadable. */
async function readTableRowIds(ctx: WalkContext, nid: number, what: string): Promise<number[]> {
  try {
    const node = await ctx.ndb.lookupNode(nid);
    if (!node) return [];
    const subnodes = await ctx.ndb.readSubnodes(node.bidSub);
    const tc = await TableContext.load(ctx.ndb, node.bidData, subnodes);
    return tc.rowIds.filter((n) => n !== 0);
  } catch (err) {
    ctx.warnings.push(`Could not read the ${what} table: ${errText(err)}.`);
    return [];
  }
}

export function hex(n: number): string {
  return "0x" + (n >>> 0).toString(16);
}

/**
 * Pull the RFC 5322 `Date:` out of a preserved transport-header block.
 *
 * This is the third link in the date fallback chain and it earns its place: a
 * real .pst turns out to be full of messages carrying neither PidTagClientSubmit-
 * Time nor PidTagMessageDeliveryTime (drafts, unsent mail, anything imported or
 * generated by a library). Those messages still have the original headers, and
 * the sender's own `Date:` is a better answer than the time the item happened to
 * be written into the store.
 */
export function dateFromHeaderBlock(raw: string | undefined): Date | null {
  if (!raw) return null;
  // Header values may be folded across continuation lines beginning with space.
  const m = /^Date:[ \t]*(.+(?:\r?\n[ \t]+.+)*)$/im.exec(raw);
  if (!m) return null;
  const d = new Date(m[1].replace(/\r?\n[ \t]+/g, " ").trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Turns a FolderPlan tree into the model's Folder tree. */
export function toFolder(plan: FolderPlan, messageIdsFor: (p: FolderPlan) => string[]): Folder {
  return {
    id: `pst-folder-${hex(plan.nid)}`,
    name: plan.name || "Top of Personal Folders",
    path: plan.path,
    children: plan.children.map((c) => toFolder(c, messageIdsFor)),
    messageIds: messageIdsFor(plan),
  };
}

// ---------------------------------------------------------------- messages

export async function buildMessage(
  ctx: WalkContext,
  nid: number,
  folderPath: string[],
  idPrefix = "pst",
): Promise<Message | null> {
  const node = await ctx.ndb.lookupNode(nid);
  if (!node) {
    ctx.warnings.push(`Message ${hex(nid)} is referenced by a folder but missing from the node BTree.`);
    return null;
  }
  const subnodes = await ctx.ndb.readSubnodes(node.bidSub);
  const pc = await PropertyContext.load(ctx.ndb, node.bidData, subnodes);
  return buildMessageFromPc(ctx, pc, subnodes, `${idPrefix}-${hex(nid)}`, folderPath);
}

async function buildMessageFromPc(
  ctx: WalkContext,
  pc: PropertyContext,
  subnodes: Map<number, SubnodeEntry>,
  id: string,
  folderPath: string[],
): Promise<Message> {
  const codepage = pc.codepage;

  const rawSubject = pc.getString(PidTagSubject) ?? "";
  const subject = stripSubjectPrefix(rawSubject);

  // "Sent representing" is the party the message claims to be from; "sender" is
  // who actually put it on the wire. They differ for delegates and mailing
  // lists, and the model wants both.
  const representing = bestAddress(
    pc.getString(PidTagSentRepresentingName),
    pc.getString(PidTagSentRepresentingAddressType),
    pc.getString(PidTagSentRepresentingEmailAddress),
    pc.getString(PidTagSentRepresentingSmtpAddress) ?? pc.getString(PidTagSmtpAddress),
  );
  const actualSender = bestAddress(
    pc.getString(PidTagSenderName),
    pc.getString(PidTagSenderAddressType),
    pc.getString(PidTagSenderEmailAddress),
    pc.getString(PidTagSenderSmtpAddress),
  );

  const from = representing ?? actualSender;
  const sender = actualSender && !sameAddress(actualSender, from) ? actualSender : undefined;

  const { to, cc, bcc } = await readRecipients(ctx, subnodes, codepage);

  // Fall back to the display strings when there is no recipient table (common
  // on messages that were never sent through a transport).
  const toFinal = to.length ? to : displayListToAddresses(pc.getString(PidTagDisplayTo));
  const ccFinal = cc.length ? cc : displayListToAddresses(pc.getString(PidTagDisplayCc));
  const bccFinal = bcc.length ? bcc : displayListToAddresses(pc.getString(PidTagDisplayBcc));

  const { html, text } = readBodies(ctx, pc, codepage, id);

  const flags = pc.getInt(PidTagMessageFlags) ?? 0;
  const attachments = await readAttachments(ctx, subnodes, id, folderPath, codepage);

  const rawHeaders = pc.getString(PidTagTransportMessageHeaders);

  /**
   * Find a send date, in descending order of authority.
   *
   * Submit and delivery time are the right answers and are what a message that
   * actually travelled over a transport will carry. But plenty of messages in a
   * real PST never did: drafts, unsent mail, anything imported or generated by a
   * library. Those have neither property, and reading only those two leaves every
   * such message dated "(none)" -- which is exactly what a real .pst showed.
   *
   * So we fall back to the RFC 5322 `Date:` line in the preserved transport
   * headers (authoritative when present -- it is the date the sender stamped),
   * and only then to the message's creation time in the store, which is really
   * "when this landed in the PST" and is a last resort rather than a send date.
   */
  const date =
    pc.getDate(PidTagClientSubmitTime) ??
    pc.getDate(PidTagMessageDeliveryTime) ??
    dateFromHeaderBlock(rawHeaders) ??
    pc.getDate(PidTagCreationTime) ??
    null;

  const headers = rawHeaders
    ? parseHeaderBlock(rawHeaders)
    : synthesizeHeaders({ from, to: toFinal, cc: ccFinal, subject, date, pc });

  const references = (pc.getString(PidTagInternetReferences) ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    id,
    format: "pst",
    subject,
    from,
    sender,
    replyTo: [],
    to: toFinal,
    cc: ccFinal,
    bcc: bccFinal,
    date,
    messageId: pc.getString(PidTagInternetMessageId),
    inReplyTo: pc.getString(PidTagInReplyToId),
    references,
    html,
    text,
    attachments,
    headers,
    folderPath,
    flags: {
      read: (flags & MSGFLAG_READ) !== 0,
      draft: (flags & MSGFLAG_UNSENT) !== 0,
      flagged: pc.getInt(PidTagFlagStatus) === 2,
      hasAttachments: attachments.length > 0,
    },
  };
}

function synthesizeHeaders(m: {
  from?: Address;
  to: Address[];
  cc: Address[];
  subject: string;
  date: Date | null;
  pc: PropertyContext;
}): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  if (m.date) out.push({ key: "Date", value: m.date.toUTCString() });
  if (m.from) out.push({ key: "From", value: formatAddress(m.from) });
  if (m.to.length) out.push({ key: "To", value: m.to.map(formatAddress).join(", ") });
  if (m.cc.length) out.push({ key: "Cc", value: m.cc.map(formatAddress).join(", ") });
  if (m.subject) out.push({ key: "Subject", value: m.subject });
  const mid = m.pc.getString(PidTagInternetMessageId);
  if (mid) out.push({ key: "Message-ID", value: mid });
  return out;
}

/**
 * Body selection.
 *
 * PidTagHtml is authoritative when present. Otherwise we fall back to the
 * compressed RTF, which for Outlook-generated mail is very often just HTML in
 * an RTF envelope -- unwrapping that recovers the real formatted body rather
 * than a lossy text approximation.
 */
function readBodies(
  ctx: WalkContext,
  pc: PropertyContext,
  codepage: number | undefined,
  id: string,
): { html?: string; text?: string } {
  let text = pc.getString(PidTagBody);
  let html: string | undefined;

  const htmlVal = pc.get(PidTagHtml);
  if (typeof htmlVal === "string" && htmlVal.length) {
    html = htmlVal;
  } else if (htmlVal instanceof Uint8Array && htmlVal.length) {
    html = decodeText(htmlVal, codepageLabel(codepage));
  }

  if (!html) {
    const compressed = pc.getBinary(PidTagRtfCompressed);
    if (compressed && compressed.length) {
      try {
        // The de-encapsulator works on the raw bytes: it decodes 8-bit runs
        // itself, against whatever `\ansicpg` declares, falling back to the
        // message's codepage when the RTF does not say.
        const recovered = deencapsulateRtf(decompressLzfu(compressed), codepage);

        if (recovered.encapsulatedHtml) {
          if (recovered.html?.trim()) html = recovered.html;
        } else if (!text) {
          if (recovered.text.trim()) text = recovered.text;
        }
      } catch (err) {
        ctx.warnings.push(`Message ${id}: the compressed RTF body could not be read (${errText(err)}).`);
      }
    }
  }

  return { html, text };
}

async function readRecipients(
  ctx: WalkContext,
  subnodes: Map<number, SubnodeEntry>,
  codepage: number | undefined,
): Promise<{ to: Address[]; cc: Address[]; bcc: Address[] }> {
  const to: Address[] = [];
  const cc: Address[] = [];
  const bcc: Address[] = [];

  const sub = subnodes.get(NID_RECIPIENT_TABLE);
  if (!sub) return { to, cc, bcc };

  try {
    const nested = await ctx.ndb.readSubnodes(sub.bidSub);
    const tc = await TableContext.load(ctx.ndb, sub.bidData, nested, codepage);

    for (let i = 0; i < tc.rowCount; i++) {
      let row: Map<number, PropEntry>;
      try {
        row = await tc.getRow(i);
      } catch (err) {
        ctx.warnings.push(`Skipped an unreadable recipient row (${errText(err)}).`);
        continue;
      }

      const addr = bestAddress(
        rowString(row, PidTagDisplayName) ?? rowString(row, PidTagRecipientDisplayName),
        rowString(row, PidTagAddressType),
        rowString(row, PidTagEmailAddress),
        rowString(row, PidTagSmtpAddress),
      );
      if (!addr) continue;

      switch (rowInt(row, PidTagRecipientType)) {
        case RECIP_CC:
          cc.push(addr);
          break;
        case RECIP_BCC:
          bcc.push(addr);
          break;
        default:
          to.push(addr);
          break;
      }
    }
  } catch (err) {
    ctx.warnings.push(`Could not read the recipient table (${errText(err)}).`);
  }

  return { to, cc, bcc };
}

async function readAttachments(
  ctx: WalkContext,
  subnodes: Map<number, SubnodeEntry>,
  msgId: string,
  folderPath: string[],
  codepage: number | undefined,
): Promise<Attachment[]> {
  const out: Attachment[] = [];

  const tableSub = subnodes.get(NID_ATTACHMENT_TABLE);
  if (!tableSub) return out;

  let attachNids: number[] = [];
  try {
    const nested = await ctx.ndb.readSubnodes(tableSub.bidSub);
    const tc = await TableContext.load(ctx.ndb, tableSub.bidData, nested, codepage);
    attachNids = tc.rowIds.filter((n) => n !== 0);
  } catch (err) {
    ctx.warnings.push(`Message ${msgId}: could not read the attachment table (${errText(err)}).`);
    return out;
  }

  for (let i = 0; i < attachNids.length; i++) {
    const attNid = attachNids[i]!;
    try {
      const att = await readAttachment(ctx, subnodes, attNid, msgId, i, folderPath, codepage);
      if (att) out.push(att);
    } catch (err) {
      ctx.warnings.push(`Message ${msgId}: attachment ${hex(attNid)} could not be read (${errText(err)}).`);
    }
  }

  return out;
}

async function readAttachment(
  ctx: WalkContext,
  subnodes: Map<number, SubnodeEntry>,
  attNid: number,
  msgId: string,
  index: number,
  folderPath: string[],
  codepage: number | undefined,
): Promise<Attachment | null> {
  const sub = subnodes.get(attNid);
  if (!sub) return null;

  // An attachment carries its own subnode BTree -- which is where an embedded
  // message's node lives.
  const attSubnodes = await ctx.ndb.readSubnodes(sub.bidSub);
  const pc = await PropertyContext.load(ctx.ndb, sub.bidData, attSubnodes, codepage);

  const method = pc.getInt(PidTagAttachMethod) ?? 0;
  const id = `${msgId}-att-${index}`;

  const longName = pc.getString(PidTagAttachLongFilename);
  const shortName = pc.getString(PidTagAttachFilename);
  const mimeTag = pc.getString(PidTagAttachMimeTag);
  const contentId = pc.getString(PidTagAttachContentId);
  const attachFlags = pc.getInt(PidTagAttachFlags) ?? 0;
  const hidden = pc.getBool(PidTagAttachmentHidden) ?? false;

  // Rendered-in-body, or referenced by a cid: URL, means it is inline artwork
  // rather than something to list as a download.
  const inline = (attachFlags & ATT_RENDERED_IN_BODY) !== 0 || (!!contentId && hidden);

  if (method === ATTACH_EMBEDDED_MESSAGE) {
    const ref = pc.get(PidTagAttachDataBinary) as ObjectRef | Uint8Array | null | undefined;

    if (ref && !(ref instanceof Uint8Array) && typeof ref === "object" && "nid" in ref) {
      const nested = attSubnodes.get(ref.nid);
      if (nested) {
        const nestedSubs = await ctx.ndb.readSubnodes(nested.bidSub);
        const nestedPc = await PropertyContext.load(ctx.ndb, nested.bidData, nestedSubs, codepage);
        const inner = await buildMessageFromPc(ctx, nestedPc, nestedSubs, `${id}-msg`, folderPath);

        const content = serializeEml(inner);
        const name = sanitizeFilename(longName ?? shortName ?? `${inner.subject || "message"}.eml`);
        return {
          id,
          filename: name.toLowerCase().endsWith(".eml") ? name : `${name}.eml`,
          mimeType: "message/rfc822",
          size: content.length,
          contentId,
          inline: false,
          content,
        };
      }
    }
    ctx.warnings.push(`Message ${msgId}: an embedded-message attachment could not be resolved.`);
    return null;
  }

  const data = pc.getBinary(PidTagAttachDataBinary);
  if (!data) {
    // by-reference attachments (method 2/3/4) store a path, not bytes. There is
    // nothing to hand the user, so record it and move on.
    ctx.warnings.push(
      `Message ${msgId}: attachment "${longName ?? shortName ?? hex(attNid)}" has no inline data ` +
        `(attach method ${method}); it was stored by reference and its bytes are not in this file.`,
    );
    return null;
  }

  const filename = sanitizeFilename(longName ?? shortName ?? `attachment-${index + 1}`);

  return {
    id,
    filename,
    mimeType: mimeTag || guessMime(filename),
    size: pc.getInt(PidTagAttachSize) ?? data.length,
    contentId,
    inline,
    content: data,
  };
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
};

function guessMime(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME_BY_EXT[filename.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
