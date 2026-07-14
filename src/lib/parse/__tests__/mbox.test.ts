import { describe, expect, it } from "vitest";
import { parseMbox } from "../mbox";

const SEP = "From dave@example.com Mon Jan  1 00:00:00 2024\r\n";

function mboxFile(messages: string[]): Blob {
  return new Blob([messages.map((m) => SEP + m).join("")], { type: "text/plain" });
}

const msg = (subject: string, body: string) =>
  `From: Dave <dave@example.com>\r\n` +
  `To: Ana <ana@example.com>\r\n` +
  `Subject: ${subject}\r\n` +
  `Date: Mon, 1 Jan 2024 00:00:00 +0000\r\n` +
  `\r\n${body}\r\n`;

describe("parseMbox", () => {
  it("splits an archive into its messages", async () => {
    const archive = await parseMbox(mboxFile([msg("one", "first"), msg("two", "second")]), "t.mbox");

    expect(archive.messages).toHaveLength(2);
    expect(archive.messages.map((m) => m.subject)).toEqual(["one", "two"]);
    expect(archive.messages[0].from?.email).toBe("dave@example.com");
    expect(archive.messages[0].to[0].email).toBe("ana@example.com");
    expect(archive.root.messageIds).toHaveLength(2);
  });

  it("unescapes '>From ' body lines that mbox escaped on write", async () => {
    // A body line beginning "From " gets a ">" prefixed when written, and the
    // reader is expected to take exactly one back off. If we don't, every
    // message quoting a From line silently gains a stray ">".
    const body = ">From the desk of Dave\r\n>>From two levels deep\r\n";
    const archive = await parseMbox(mboxFile([msg("quoting", body)]), "t.mbox");

    expect(archive.messages[0].text).toContain("From the desk of Dave");
    expect(archive.messages[0].text).toContain(">From two levels deep");
  });

  it("does not treat a 'From ' inside a body as a message boundary", async () => {
    // Only a line-initial "From " separates messages. This body contains the
    // word mid-line, which must not split the archive.
    const archive = await parseMbox(
      mboxFile([msg("inline", "a note From Dave, mid-sentence\r\n")]),
      "t.mbox",
    );
    expect(archive.messages).toHaveLength(1);
  });

  it("keeps going when one message is corrupt", async () => {
    const good = msg("survivor", "still here");
    // A message whose headers are pure binary noise.
    const bad = "\x00\x01\x02\x03\r\n\r\n";
    const archive = await parseMbox(mboxFile([bad, good]), "t.mbox");

    // The healthy message must survive its damaged neighbour: losing 40,000
    // messages because one is broken is the failure mode that matters here.
    expect(archive.messages.some((m) => m.subject === "survivor")).toBe(true);
  });

  it("rejects a file with no separator lines rather than inventing a message", async () => {
    const notMbox = new Blob(["Subject: lonely\r\n\r\nno separator here"]);
    await expect(parseMbox(notMbox, "x.mbox")).rejects.toThrow(/separator/i);
  });
});
