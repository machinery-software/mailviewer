import { describe, expect, it } from "vitest";
import { deencapsulateRtf } from "../rtf.ts";

const enc = new TextEncoder();
/** The de-encapsulator takes bytes; most vectors here are easier to read as text. */
const rtf = (s: string): Uint8Array => enc.encode(s);
/** ...but a \'xx vector needs the byte, not the UTF-8 expansion, so keep both. */
const latin1 = (s: string): Uint8Array =>
  Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

// ---------------------------------------------------------------------------
// Detecting encapsulation
// ---------------------------------------------------------------------------

describe("deencapsulateRtf: detecting encapsulated HTML", () => {
  it("spots the \\fromhtml1 marker", () => {
    expect(deencapsulateRtf(rtf("{\\rtf1\\ansi\\fromhtml1 \\htmlrtf ...")).encapsulatedHtml).toBe(
      true,
    );
  });

  it("does not fire on ordinary rich text", () => {
    expect(deencapsulateRtf(rtf("{\\rtf1\\ansi\\deff0 plain rich text}")).encapsulatedHtml).toBe(
      false,
    );
  });

  it("also accepts a \\*\\htmltag destination as proof of encapsulation", () => {
    // Some producers omit \fromhtml1 but still encapsulate.
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi{\\*\\htmltag84 <html>}hi{\\*\\htmltag84 </html>}}"));
    expect(r.encapsulatedHtml).toBe(true);
    expect(r.html).toBe("<html>hi</html>");
  });
});

// ---------------------------------------------------------------------------
// HTML de-encapsulation (MS-OXRTFEX)
// ---------------------------------------------------------------------------

describe("deencapsulateRtf: encapsulated HTML", () => {
  it("extracts HTML from an encapsulated (\\fromhtml1) body", () => {
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi\\ansicpg1252\\fromhtml1\\deff0\n" +
          "{\\fonttbl{\\f0\\fswiss Arial;}}\n" +
          "{\\*\\htmltag19 <html>}\n" +
          "{\\*\\htmltag34 <body>}\n" +
          "{\\*\\htmltag80 <p>}\n" +
          "Hello, world!\n" +
          "{\\*\\htmltag84 </p>}\n" +
          "{\\*\\htmltag42 </body>}\n" +
          "{\\*\\htmltag27 </html>}\n" +
          "}",
      ),
    );
    expect(r.encapsulatedHtml).toBe(true);
    expect(r.html).toBe("<html><body><p>Hello, world!</p></body></html>");
    expect(r.text).toBe("Hello, world!");
  });

  /**
   * The shape Outlook actually emits: markup hidden in \*\htmltag destinations,
   * the visible text sitting in the RTF body.
   */
  it("recovers markup from htmltag groups and text from the body", () => {
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi\\fromhtml1\\deff0" +
          "{\\*\\htmltag84 <html>}" +
          "{\\*\\htmltag64 <body>}" +
          "{\\*\\htmltag112 <p>}" +
          "Hello world" +
          "{\\*\\htmltag112 </p>}" +
          "{\\*\\htmltag64 </body>}" +
          "{\\*\\htmltag84 </html>}" +
          "}",
      ),
    );
    expect(r.html).toBe("<html><body><p>Hello world</p></body></html>");
  });

  it("drops the RTF-only regions fenced by \\htmlrtf", () => {
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi\\fromhtml1\n" +
          "{\\*\\htmltag64 <p>}Visible\\htmlrtf \\par This is RTF-only\\htmlrtf0 Also visible" +
          "{\\*\\htmltag68 </p>}\n" +
          "}",
      ),
    );
    expect(r.html).toBe("<p>VisibleAlso visible</p>");
  });

  it("drops content bracketed by \\htmlrtf ... \\htmlrtf0", () => {
    // \htmlrtf hides the RTF-only rendition; the \f0\fs20 and the duplicated
    // text inside it must not reach the output.
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi\\fromhtml1" +
          "{\\*\\htmltag112 <p>}" +
          "\\htmlrtf \\f0\\fs20 IGNORED\\htmlrtf0 " +
          "Kept" +
          "{\\*\\htmltag112 </p>}" +
          "}",
      ),
    );
    expect(r.html).toContain("Kept");
    expect(r.html).not.toContain("IGNORED");
  });

  it("restores the \\htmlrtf state when a group closes", () => {
    // Suppression nests with groups: the \htmlrtf inside the braces must not
    // leak out and swallow the text that follows them.
    const r = deencapsulateRtf(
      rtf("{\\rtf1\\ansi\\fromhtml1 A{\\htmlrtf hidden}B}"),
    );
    expect(r.html).toBe("AB");
  });

  it("unescapes \\{ \\} and \\\\", () => {
    const r = deencapsulateRtf(rtf("{\\rtf1\\fromhtml1 a\\{b\\}c\\\\d}"));
    expect(r.html).toBe("a{b}c\\d");
  });

  it("decodes \\uN unicode escapes and skips the ANSI fallback", () => {
    // 8364 is the euro sign. The '?' immediately after it is the ANSI fallback
    // character that \uc1 says to discard.
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi\\fromhtml1\\uc1 price: \\u8364 ?100}"));
    expect(r.html).toContain("€");
    expect(r.html).not.toContain("?");
  });
});

// ---------------------------------------------------------------------------
// Codepages
// ---------------------------------------------------------------------------

describe("deencapsulateRtf: codepages", () => {
  it("decodes \\'hh escapes in the declared codepage", () => {
    // windows-1252 0xE9 is e-acute.
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi\\ansicpg1252 caf\\'e9 au lait\\par}"));
    expect(r.text).toBe("café au lait");
  });

  it("decodes \\'hh escapes against a caller-supplied codepage when the RTF is silent", () => {
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi\\fromhtml1 caf\\'e9}"), 1252);
    expect(r.html).toContain("café");
  });

  it("lets \\ansicpg win over the caller's hint", () => {
    // The stream says 1252, the caller guessed Cyrillic. The stream is right:
    // 0xE9 is e-acute in 1252 but 'й' in windows-1251.
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi\\ansicpg1252 caf\\'e9}"), 1251);
    expect(r.text).toBe("café");
  });

  it("falls back to the hint's codepage when there is no \\ansicpg", () => {
    const r = deencapsulateRtf(latin1("{\\rtf1\\ansi caf\\'e9}"), 1251);
    expect(r.text).toBe("cafй");
  });

  it("decodes \\uN escapes and skips the ANSI fallback", () => {
    // 荤 is the euro sign; \'80 is the 1252 fallback the writer emitted
    // alongside it, and must not be shown twice.
    const r = deencapsulateRtf(rtf("{\\rtf1\\ansi\\ansicpg1252\\uc1 Price: \\u8364\\'80 5\\par}"));
    expect(r.text).toBe("Price: € 5");
  });
});

// ---------------------------------------------------------------------------
// Plain-text extraction from genuine RTF
// ---------------------------------------------------------------------------

describe("deencapsulateRtf: genuine rich text", () => {
  it("degrades genuine RTF to plain text", () => {
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\froman Times;}}" +
          "\\pard Plain \\b bold\\b0  text.\\par}",
      ),
    );
    expect(r.encapsulatedHtml).toBe(false);
    expect(r.html).toBeUndefined();
    expect(r.text).toBe("Plain bold text.");
  });

  it("strips control words and returns the body text", () => {
    const r = deencapsulateRtf(
      rtf("{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Hello\\par World}"),
    );
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("World");
    // The font table is metadata, never body text.
    expect(r.text).not.toContain("Arial");
  });

  it("turns \\par into a newline", () => {
    expect(deencapsulateRtf(rtf("{\\rtf1 a\\par b}")).text).toBe("a\nb");
  });

  it("skips ignorable destinations like \\*\\generator", () => {
    const r = deencapsulateRtf(rtf("{\\rtf1{\\*\\generator Riched20 10.0}real text}"));
    expect(r.text).toContain("real text");
    expect(r.text).not.toContain("Riched20");
  });

  it("skips control-table destinations entirely", () => {
    const r = deencapsulateRtf(
      rtf(
        "{\\rtf1\\ansi{\\fonttbl{\\f0 ShouldNotAppear;}}" +
          "{\\colortbl;\\red0\\green0\\blue0;}" +
          "{\\*\\generator Microsoft Exchange;}" +
          "Body text}",
      ),
    );
    expect(r.text).toBe("Body text");
  });
});
