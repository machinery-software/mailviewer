/**
 * An Outlook template (.oft) is a MAPI compound file, structurally identical to
 * a .msg, so it goes through the same parser. This proves a CFB container whose
 * only distinguishing feature is its .oft name parses as a real message.
 */
import { describe, expect, it } from "vitest";
import { parseMsg } from "../msg";
import { detectFormat } from "../detect";
import { buildCfb, stream, type BuildNode } from "./cfbBuilder.ts";
import { PT } from "../msg";

const utf16 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
  return out;
};

const formatTag = (id: number, type: number) =>
  (((id << 16) >>> 0) | type).toString(16).padStart(8, "0").toUpperCase();

const strProp = (id: number, value: string): BuildNode =>
  stream(`__substg1.0_${formatTag(id, PT.STRING)}`, utf16(value));

const propsStream = (): BuildNode => stream("__properties_version1.0", new Uint8Array(32));

describe("Outlook template (.oft)", () => {
  it("is sniffed as oft by name while other compound files stay msg", () => {
    const cfbHead = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(detectFormat(cfbHead, "welcome.oft")).toBe("oft");
    expect(detectFormat(cfbHead, "welcome.msg")).toBe("msg");
  });

  it("parses a compound file named .oft as a message", async () => {
    const bytes = buildCfb([
      strProp(0x0037, "Meeting template"),
      strProp(0x0c1a, "Template Owner"),
      strProp(0x0c1f, "owner@example.com"),
      strProp(0x1000, "Fill in the details."),
      propsStream(),
    ]);

    const archive = await parseMsg(bytes, "meeting.oft");
    expect(archive.messages).toHaveLength(1);

    const m = archive.messages[0];
    expect(m.subject).toBe("Meeting template");
    expect(m.from).toEqual({ name: "Template Owner", email: "owner@example.com" });
    expect(m.text).toBe("Fill in the details.");
  });
});
