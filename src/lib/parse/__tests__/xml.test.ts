/**
 * The DOM-free XML reader behind the .olm parser (MAC-513).
 *
 * It replaces DOMParser, so it is held to what DOMParser did for this job:
 * the same tree for well-formed input, and a refusal -- not a half-read -- for
 * input a browser's XML parser would reject.
 */
import { describe, expect, it } from "vitest";
import { descendants, firstDescendant, parseXml, textContent, XmlError } from "../xml";

describe("parseXml", () => {
  it("reads elements, attributes in order, text, CDATA, comments and PIs", () => {
    const root = parseXml(
      '﻿<?xml version="1.0" encoding="UTF-8"?>\n<!-- exported -->\n' +
        '<emails><email a="1" b=\'two\'>' +
        "<s xml:space=\"preserve\">Hi <![CDATA[<b>&raw</b>]]> there</s><e/>" +
        "<?app note?></email></emails>\n<!-- trailing -->\n",
    );
    expect(root.name).toBe("emails");
    const email = firstDescendant(root, "email")!;
    expect(email.attributes).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "two" },
    ]);
    expect(textContent(firstDescendant(root, "s")!)).toBe("Hi <b>&raw</b> there");
    expect(firstDescendant(root, "e")!.children).toEqual([]);
    expect(firstDescendant(root, "missing")).toBeNull();
  });

  it("decodes the predefined entities and character references", () => {
    const root = parseXml(
      '<r t="&lt;a&gt; &amp; &quot;q&quot; &apos;s&apos;">&lt;p&gt;Hello &amp; welcome&#33; &#x1F600;&#169;</r>',
    );
    expect(root.attributes[0].value).toBe(`<a> & "q" 's'`);
    expect(textContent(root)).toBe("<p>Hello & welcome! \u{1F600}©");
  });

  it("normalises line ends, and literal whitespace in attribute values", () => {
    const root = parseXml('<r v="a\r\nb\tc&#10;d">one\r\ntwo\rthree</r>');
    expect(root.attributes[0].value).toBe("a b c\nd");
    expect(textContent(root)).toBe("one\ntwo\nthree");
  });

  it("finds descendants in document order, as getElementsByTagName does", () => {
    const root = parseXml("<a><x i='1'><x i='2'/></x><y><x i='3'/></y></a>");
    expect(descendants(root, "x").map((x) => x.attributes[0].value)).toEqual(["1", "2", "3"]);
  });

  it("survives nesting far deeper than a recursive reader's stack", () => {
    const depth = 200_000;
    const root = parseXml("<d>".repeat(depth) + "deep" + "</d>".repeat(depth));
    expect(textContent(root)).toBe("deep");
    expect(descendants(root, "d")).toHaveLength(depth - 1);
  });

  const refused: Array<[string, string]> = [
    ["an unclosed element", "<emails><email><s>Broken"],
    ["mismatched tags", "<a><b></a></b>"],
    ["a stray closing tag", "<a></a></b>"],
    ["a bare ampersand", "<a>Fish & chips</a>"],
    ["an unknown entity", "<a>&nbsp;</a>"],
    ["an entity declared in a DOCTYPE", '<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>'],
    ["a second root", "<a/><b/>"],
    ["text outside the root", "<a/>trailing"],
    ["an unquoted attribute", "<a b=1/>"],
    ["a duplicated attribute", '<a b="1" b="2"/>'],
    ["an unterminated comment", "<a><!-- never</a>"],
    ["a reference to code point 0", "<a>&#0;</a>"],
    ["an empty document", "   "],
  ];
  for (const [what, xml] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => parseXml(xml)).toThrow(XmlError);
    });
  }
});
