/**
 * A small, DOM-free XML reader.
 *
 * The parsers run in a Web Worker, and the same code runs again inside the Mac
 * app's parse service on bare JavaScriptCore. Neither has DOMParser, document or
 * window, so this uses nothing but the language: strings in, a plain tree out.
 * The .olm reader once called DOMParser and passed its tests only because jsdom
 * supplied one; in production every .olm failed (MAC-513).
 *
 * It reads well-formed XML 1.0 as mail archives write it: elements, attributes,
 * text, CDATA, comments and processing instructions, the five predefined
 * entities and numeric character references. It is a reader, not a validator,
 * but it refuses what a browser's XML parser would refuse -- mismatched or
 * unclosed tags, a bare "&", an unknown entity, a second root -- so a damaged
 * file is reported as damaged instead of being half-read.
 *
 * Deliberately unsupported: entities declared in a DOCTYPE. The DOCTYPE is
 * skipped and any entity it would have defined is an error. That closes the
 * entity-expansion attacks ("billion laughs") outright, and no Outlook for Mac
 * export declares one.
 *
 * Everything is iterative, so a hostile file nested a million deep costs memory
 * rather than a stack overflow.
 */

export interface XmlAttribute {
  name: string;
  value: string;
}

export interface XmlElement {
  name: string;
  /** In document order, as the archive wrote them. */
  attributes: XmlAttribute[];
  /** Child elements and text runs (strings), in document order. */
  children: Array<XmlElement | string>;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

const NAME = /[^\s/>=<"'!?&;][^\s/>=<"'&;]*/y;
const SPACE = /[ \t\n]*/y;
const ENTITY = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z_][\w.-]*));/g;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(raw: string, at: number): string {
  if (raw.indexOf("&") === -1) return raw;
  // Every "&" must begin a reference. What is left once the references are
  // removed is a bare ampersand, which no conforming writer produces.
  if (raw.replace(ENTITY, "").indexOf("&") !== -1) {
    throw new XmlError(`An "&" that is not part of an entity, near offset ${at}`);
  }
  return raw.replace(ENTITY, (_m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (name !== undefined) {
      const ch = PREDEFINED[name];
      if (ch === undefined) throw new XmlError(`Unknown entity "&${name};" near offset ${at}`);
      return ch;
    }
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) {
      throw new XmlError(`Character reference to an invalid code point near offset ${at}`);
    }
    return String.fromCodePoint(code);
  });
}

/** Parse a whole document and return its root element. Throws XmlError. */
export function parseXml(input: string): XmlElement {
  // XML end-of-line handling: CRLF and lone CR both become LF before parsing.
  const src = input.indexOf("\r") === -1 ? input : input.replace(/\r\n?/g, "\n");
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const fail = (what: string): never => {
    throw new XmlError(`${what}, near offset ${i}`);
  };
  const until = (marker: string, from: number, what: string): number => {
    const at = src.indexOf(marker, from);
    if (at === -1) fail(what);
    return at;
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const raw = src.slice(i, textEnd);
      if (stack.length) stack[stack.length - 1].children.push(decodeEntities(raw, i));
      else if (/\S/.test(raw)) fail("Text outside the root element");
      i = textEnd;
      if (lt === -1) break;
    }

    if (src.startsWith("<!--", i)) {
      i = until("-->", i + 4, "An unterminated comment") + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      if (!stack.length) fail("CDATA outside the root element");
      const end = until("]]>", i + 9, "An unterminated CDATA section");
      stack[stack.length - 1].children.push(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      i = until("?>", i + 2, "An unterminated processing instruction") + 2;
      continue;
    }
    if (src.startsWith("<!DOCTYPE", i)) {
      if (root || stack.length) fail("A DOCTYPE after the root element");
      // Skip it, internal subset and all. Entities it declares stay undefined.
      let j = i + 9;
      let depth = 0;
      for (; j < n; j++) {
        const c = src[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      if (j >= n) fail("An unterminated DOCTYPE");
      i = j + 1;
      continue;
    }

    if (src[i + 1] === "/") {
      const gt = until(">", i + 2, "An unterminated closing tag");
      const name = src.slice(i + 2, gt).trim();
      const open = stack.pop();
      if (!open) fail(`A closing </${name}> with nothing open`);
      if (open!.name !== name) fail(`<${open!.name}> closed by </${name}>`);
      i = gt + 1;
      continue;
    }

    // An opening tag.
    NAME.lastIndex = i + 1;
    const nameMatch = NAME.exec(src);
    if (!nameMatch) fail('A "<" that does not begin a tag');
    const el: XmlElement = { name: nameMatch![0], attributes: [], children: [] };
    if (!stack.length && root) fail("A second root element");
    i = NAME.lastIndex;

    let selfClosing = false;
    for (;;) {
      SPACE.lastIndex = i;
      SPACE.exec(src);
      const spaced = SPACE.lastIndex > i;
      i = SPACE.lastIndex;
      if (i >= n) fail(`An unterminated <${el.name}> tag`);
      if (src[i] === ">") {
        i++;
        break;
      }
      if (src.startsWith("/>", i)) {
        i += 2;
        selfClosing = true;
        break;
      }
      if (!spaced) fail(`No space before an attribute of <${el.name}>`);

      NAME.lastIndex = i;
      const attrMatch = NAME.exec(src);
      if (!attrMatch) fail(`A malformed attribute in <${el.name}>`);
      const attrName = attrMatch![0];
      i = NAME.lastIndex;
      SPACE.lastIndex = i;
      SPACE.exec(src);
      i = SPACE.lastIndex;
      if (src[i] !== "=") fail(`Attribute "${attrName}" has no value`);
      SPACE.lastIndex = i + 1;
      SPACE.exec(src);
      i = SPACE.lastIndex;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`Attribute "${attrName}" is not quoted`);
      const close = until(quote, i + 1, `Attribute "${attrName}" is never closed`);
      const raw = src.slice(i + 1, close);
      if (raw.indexOf("<") !== -1) fail(`A "<" inside attribute "${attrName}"`);
      if (el.attributes.some((a) => a.name === attrName)) fail(`Attribute "${attrName}" given twice`);
      // Attribute-value normalisation: literal whitespace becomes a space;
      // whitespace written as a character reference survives.
      el.attributes.push({ name: attrName, value: decodeEntities(raw.replace(/[\t\n]/g, " "), i) });
      i = close + 1;
    }

    if (stack.length) stack[stack.length - 1].children.push(el);
    else root = el;
    if (!selfClosing) stack.push(el);
  }

  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].name}> is never closed (the document ends first)`);
  if (!root) throw new XmlError("No root element");
  return root;
}

/** Every descendant element named `name`, in document order (getElementsByTagName). */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const pending: Array<XmlElement | string> = [...el.children].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") continue;
    if (node.name === name) out.push(node);
    for (let k = node.children.length - 1; k >= 0; k--) pending.push(node.children[k]);
  }
  return out;
}

/** The first descendant element named `name`, or null. */
export function firstDescendant(el: XmlElement, name: string): XmlElement | null {
  const pending: Array<XmlElement | string> = [...el.children].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") continue;
    if (node.name === name) return node;
    for (let k = node.children.length - 1; k >= 0; k--) pending.push(node.children[k]);
  }
  return null;
}

/** All the text inside `el`, concatenated (textContent). */
export function textContent(el: XmlElement): string {
  let out = "";
  const pending: Array<XmlElement | string> = [...el.children].reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") out += node;
    else for (let k = node.children.length - 1; k >= 0; k--) pending.push(node.children[k]);
  }
  return out;
}
