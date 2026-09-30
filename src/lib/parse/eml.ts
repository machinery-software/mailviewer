import PostalMime from "postal-mime";
import type { Address, Attachment, Message, ParsedArchive } from "../model";
import { singleMessageArchive } from "./archive";
import { partContentLocations } from "./mhtml";
import { MAX_MIME_PARTS, capMimeParts } from "./mimeParts";
import { extractTnefAttachments } from "./tnef";

/**
 * Apple Mail's .emlx wraps a plain RFC822 message in a byte-count prefix line
 * and a trailing plist of Apple-internal flags. Strip both and we have an .eml.
 */
export function stripEmlxWrapper(bytes: Uint8Array): Uint8Array {
  const nl = bytes.indexOf(0x0a);
  if (nl === -1) return bytes;

  const firstLine = new TextDecoder("latin1").decode(bytes.subarray(0, nl)).trim();
  const declaredLength = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(declaredLength) || declaredLength <= 0) return bytes;

  const start = nl + 1;
  // Trust the declared length, but never read past the end of the buffer -- a
  // truncated .emlx should still render whatever message body survived.
  const end = Math.min(start + declaredLength, bytes.length);
  return bytes.subarray(start, end);
}

function toAddress(a: { address?: string | null; name?: string | null } | null | undefined): Address | undefined {
  if (!a?.address) return undefined;
  return { email: a.address, name: a.name || undefined };
}

function toAddresses(list: Array<{ address?: string | null; name?: string | null }> | null | undefined): Address[] {
  if (!list) return [];
  return list.map(toAddress).filter((a): a is Address => !!a);
}

/**
 * True for the attachment Outlook produces when it gives up on MIME: a TNEF
 * blob. The MIME type is the reliable signal, but plenty of gateways strip it
 * down to application/octet-stream and leave only the name behind.
 */
function isTnefPart(a: Attachment): boolean {
  const mime = a.mimeType.toLowerCase().split(";")[0].trim();
  return (
    mime === "application/ms-tnef" ||
    mime === "application/vnd.ms-tnef" ||
    a.filename.toLowerCase() === "winmail.dat"
  );
}

/**
 * Expand any winmail.dat part in place: the real attachments it was carrying
 * take its position in the list, and its body -- which is the *only* copy of
 * the formatted body when Outlook has done this -- fills in for a message that
 * has none.
 *
 * A user with a winmail.dat should never see a winmail.dat. But if expansion
 * fails, the opaque part stays exactly where it was: an attachment they can
 * download and take elsewhere beats an attachment we quietly deleted.
 */
function expandTnefParts(message: Message, warnings: string[]): void {
  if (!message.attachments.some(isTnefPart)) return;

  const expanded: Attachment[] = [];
  let changed = false;

  for (const att of message.attachments) {
    if (!isTnefPart(att)) {
      expanded.push(att);
      continue;
    }
    try {
      const tnef = extractTnefAttachments(att.content);
      for (const w of tnef.warnings) warnings.push(`${att.filename}: ${w}`);

      const gainsBody = (!message.html && !!tnef.html) || (!message.text && !!tnef.text);
      if (tnef.attachments.length === 0 && !gainsBody) {
        // Nothing inside worth trading the original for.
        warnings.push(
          `${att.filename}: TNEF part contained no attachments or body; left as-is.`,
        );
        expanded.push(att);
        continue;
      }

      if (!message.html && tnef.html) message.html = tnef.html;
      if (!message.text && tnef.text) message.text = tnef.text;

      tnef.attachments.forEach((inner, i) => {
        expanded.push({ ...inner, id: `${att.id}:tnef:${i}` });
      });
      changed = true;
    } catch (err) {
      warnings.push(
        `${att.filename}: TNEF attachment could not be expanded (${
          err instanceof Error ? err.message : String(err)
        }); it is still available as a download.`,
      );
      expanded.push(att);
    }
  }

  if (!changed) return;
  message.attachments = expanded;
  message.flags.hasAttachments = expanded.some((a) => !a.inline);
}

/**
 * Parse one RFC822/MIME message into the common model.
 *
 * `warnings`, when given, collects non-fatal problems (currently: a winmail.dat
 * part that would not expand) for the archive to report. A message cut off at
 * the MIME part cap is not one of them: it says so itself, in `omittedParts`.
 */
export async function parseEmlMessage(
  bytes: Uint8Array,
  id: string,
  folderPath: string[],
  format: "eml" | "emlx" | "mbox" | "mht",
  warnings: string[] = [],
): Promise<Message> {
  const source = format === "emlx" ? stripEmlxWrapper(bytes) : bytes;

  // postal-mime's cost is quadratic in the number of parts, so a message with
  // an absurd number of them is cut off before it gets there -- see
  // mimeParts.ts. `raw` below is still the whole message.
  const capped = capMimeParts(source);

  // postal-mime wants a standalone ArrayBuffer; a subarray's buffer may be the
  // whole multi-gigabyte mbox, so copy the slice we actually mean.
  const buf = capped.bytes.slice().buffer as ArrayBuffer;
  const email = await new PostalMime().parse(buf);

  const attachments: Attachment[] = (email.attachments ?? []).map((att, i) => {
    const content =
      typeof att.content === "string"
        ? new TextEncoder().encode(att.content)
        : new Uint8Array(att.content as ArrayBuffer);

    const contentId = att.contentId?.replace(/^<|>$/g, "") || undefined;

    return {
      id: `${id}:att:${i}`,
      filename: att.filename || `attachment-${i + 1}`,
      mimeType: att.mimeType || "application/octet-stream",
      size: content.byteLength,
      contentId,
      // "related" means the part is referenced from the body (an inline image)
      // rather than offered to the user as a file to save.
      inline: att.disposition === "inline" || !!att.related,
      content,
    };
  });

  // MHTML references inline sub-resources by Content-Location, a header
  // postal-mime does not surface on attachments. Recover it from the raw
  // container and pair it with each attachment by position -- both lists are in
  // document order (see mhtml.ts) -- so sanitize.ts can resolve body `src`
  // attributes against it the way it resolves cid: for ordinary mail.
  if (format === "mht") {
    const locations = partContentLocations(source);
    attachments.forEach((att, i) => {
      const loc = locations[i];
      if (loc) att.contentLocation = loc;
    });
  }

  const headers = (email.headers ?? []).map((h) => ({ key: h.key, value: h.value }));

  const references = (email.references ?? "")
    .split(/\s+/)
    .map((r) => r.trim())
    .filter(Boolean);

  const message: Message = {
    id,
    format,
    subject: email.subject || "(no subject)",
    from: toAddress(email.from),
    sender: toAddress((email as { sender?: { address?: string; name?: string } }).sender),
    replyTo: toAddresses(email.replyTo),
    to: toAddresses(email.to),
    cc: toAddresses(email.cc),
    bcc: toAddresses(email.bcc),
    date: email.date ? new Date(email.date) : null,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references,
    html: email.html || undefined,
    text: email.text || undefined,
    attachments,
    headers,
    raw: source,
    folderPath,
    flags: {
      hasAttachments: attachments.some((a) => !a.inline),
    },
  };

  if (capped.omittedParts > 0) {
    message.omittedParts = { total: capped.totalParts, shown: MAX_MIME_PARTS };
  }

  expandTnefParts(message, warnings);

  return message;
}

export async function parseEml(
  bytes: Uint8Array,
  name: string,
  format: "eml" | "emlx" | "mht" = "eml",
): Promise<ParsedArchive> {
  const warnings: string[] = [];
  const message = await parseEmlMessage(bytes, "msg-0", [name], format, warnings);
  return singleMessageArchive(message, name, format, warnings);
}
