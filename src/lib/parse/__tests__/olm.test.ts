/**
 * @vitest-environment jsdom
 *
 * An .olm is a ZIP of Outlook-for-Mac XML. Rather than check in a binary
 * fixture, this builds a real ZIP with fflate containing a realistic two-folder
 * layout and an attachment, then proves the folder tree, message fields and
 * attachment bytes all come back. DOMParser (used by the parser) is provided by
 * jsdom here; in production it is the Web Worker's own.
 */
import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseOlm } from "../olm";
import type { Folder } from "../../model";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

const msg1Xml = `<?xml version="1.0" encoding="UTF-8"?>
<emails>
  <email>
    <OPFMessageCopySubject>Quarterly report</OPFMessageCopySubject>
    <OPFMessageCopyFrom>
      <emailAddress OPFContactEmailAddressAddress="alice@example.com" OPFContactEmailAddressName="Alice Sender"/>
    </OPFMessageCopyFrom>
    <OPFMessageCopyToAddresses>
      <emailAddress OPFContactEmailAddressAddress="bob@example.com" OPFContactEmailAddressName="Bob Recipient"/>
    </OPFMessageCopyToAddresses>
    <OPFMessageCopyCCAddresses>
      <emailAddress OPFContactEmailAddressAddress="carol@example.com" OPFContactEmailAddressName="Carol Copied"/>
    </OPFMessageCopyCCAddresses>
    <OPFMessageCopySentTime>2021-01-01T00:00:00Z</OPFMessageCopySentTime>
    <OPFMessageCopyMessageID>&lt;abc@example.com&gt;</OPFMessageCopyMessageID>
    <OPFMessageCopyBody>The plain text body.</OPFMessageCopyBody>
    <OPFMessageCopyHTMLBody>&lt;p&gt;Hello &amp; welcome&lt;/p&gt;</OPFMessageCopyHTMLBody>
    <OPFMessageCopyAttachmentList>
      <messageAttachment OPFAttachmentContentType="application/pdf" OPFAttachmentName="report.pdf" OPFAttachmentURL="Accounts/Acme/Attachments/1a/report.pdf"/>
    </OPFMessageCopyAttachmentList>
  </email>
</emails>`;

const msg2Xml = `<?xml version="1.0" encoding="UTF-8"?>
<emails>
  <email>
    <OPFMessageCopySubject>Project kickoff</OPFMessageCopySubject>
    <OPFMessageCopyFrom>
      <emailAddress OPFContactEmailAddressAddress="dave@example.com" OPFContactEmailAddressName="Dave Lead"/>
    </OPFMessageCopyFrom>
    <OPFMessageCopyToAddresses>
      <emailAddress OPFContactEmailAddressAddress="team@example.com" OPFContactEmailAddressName="The Team"/>
    </OPFMessageCopyToAddresses>
    <OPFMessageCopyBody>Kickoff is Monday.</OPFMessageCopyBody>
  </email>
</emails>`;

function buildOlm(): Uint8Array {
  return zipSync({
    // Inbox message (bucket dir "1a" is storage plumbing, not a folder).
    "Accounts/Acme/Message/Inbox/1a/message_00001.xml": strToU8(msg1Xml),
    // Inbox/Projects message.
    "Accounts/Acme/Message/Inbox/Projects/2b/message_00002.xml": strToU8(msg2Xml),
    // Attachment bytes live elsewhere in the archive, referenced by URL.
    "Accounts/Acme/Attachments/1a/report.pdf": PDF,
    // A stray non-message entry the reader must ignore.
    "Accounts/Acme/settings.plist": strToU8("<plist/>"),
  });
}

/** fflate returns Uint8Array<ArrayBufferLike>; Blob wants a plain ArrayBuffer view. */
const blob = (u8: Uint8Array): Blob => new Blob([u8 as BlobPart]);

function findFolder(root: Folder, name: string): Folder | undefined {
  if (root.name === name) return root;
  for (const c of root.children) {
    const hit = findFolder(c, name);
    if (hit) return hit;
  }
  return undefined;
}

describe("Outlook for Mac (.olm)", () => {
  it("reconstructs the folder tree, message fields and attachment bytes", async () => {
    const file = blob(buildOlm());
    const archive = await parseOlm(file, "archive.olm");

    expect(archive.format).toBe("olm");
    expect(archive.warnings).toEqual([]);
    expect(archive.messages).toHaveLength(2);

    // --- Folder tree ---------------------------------------------------------
    expect(archive.root.name).toBe("archive.olm");
    const inbox = findFolder(archive.root, "Inbox");
    const projects = findFolder(archive.root, "Projects");
    expect(inbox).toBeDefined();
    expect(projects).toBeDefined();
    // Projects is nested under Inbox, not a sibling of it.
    expect(inbox!.children.map((c) => c.name)).toContain("Projects");

    const byId = new Map(archive.messages.map((m) => [m.id, m]));
    const inboxMsg = inbox!.messageIds.map((id) => byId.get(id)!);
    const projMsg = projects!.messageIds.map((id) => byId.get(id)!);
    expect(inboxMsg.map((m) => m.subject)).toEqual(["Quarterly report"]);
    expect(projMsg.map((m) => m.subject)).toEqual(["Project kickoff"]);

    // --- Message fields ------------------------------------------------------
    const m = inboxMsg[0];
    expect(m.from).toEqual({ name: "Alice Sender", email: "alice@example.com" });
    expect(m.to).toEqual([{ name: "Bob Recipient", email: "bob@example.com" }]);
    expect(m.cc).toEqual([{ name: "Carol Copied", email: "carol@example.com" }]);
    expect(m.date?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(m.messageId).toBe("<abc@example.com>");
    expect(m.text).toBe("The plain text body.");
    // The HTML body was XML-escaped in the archive and is decoded back to markup.
    expect(m.html).toBe("<p>Hello & welcome</p>");
    expect(m.folderPath).toEqual(["Inbox"]);

    // --- Attachment ----------------------------------------------------------
    expect(m.flags.hasAttachments).toBe(true);
    expect(m.attachments).toHaveLength(1);
    const att = m.attachments[0];
    expect(att.filename).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    expect(att.content).toEqual(PDF);

    // The second message really is under Inbox/Projects.
    expect(projMsg[0].folderPath).toEqual(["Inbox", "Projects"]);
  });

  it("warns but keeps the message when an attachment's bytes are missing", async () => {
    const xml = msg1Xml.replace(
      "Accounts/Acme/Attachments/1a/report.pdf",
      "Accounts/Acme/Attachments/1a/gone.pdf",
    );
    const zip = zipSync({
      "Accounts/Acme/Message/Inbox/1a/message_00001.xml": strToU8(xml),
    });
    const archive = await parseOlm(blob(zip), "x.olm");

    expect(archive.messages).toHaveLength(1);
    expect(archive.messages[0].attachments).toHaveLength(0);
    expect(archive.warnings.join(" ")).toMatch(/gone\.pdf.*not in the archive/i);
  });

  it("warns on a corrupt message XML but still returns the healthy ones", async () => {
    const zip = zipSync({
      // Unterminated element: the browser's XML parser will reject this.
      "Accounts/Acme/Message/Inbox/1a/broken.xml": strToU8(
        '<?xml version="1.0"?><emails><email><OPFMessageCopySubject>Broken',
      ),
      "Accounts/Acme/Message/Inbox/2b/message_00002.xml": strToU8(msg2Xml),
    });
    const archive = await parseOlm(blob(zip), "x.olm");

    // The healthy message survived...
    expect(archive.messages).toHaveLength(1);
    expect(archive.messages[0].subject).toBe("Project kickoff");
    // ...and the corrupt one is reported rather than silently dropped.
    expect(archive.warnings.join(" ")).toMatch(/broken\.xml/i);
  });
});
