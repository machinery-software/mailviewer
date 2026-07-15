import { createElement, type ReactNode } from "react";

/**
 * Case-insensitive substring highlighting for search results.
 *
 * Matching is plain indexOf, not a regex, so the query never needs escaping and
 * a user searching for "a.b*" gets a literal match rather than a pattern.
 */

export function countMatches(text: string | undefined, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q || !text) return 0;
  const t = text.toLowerCase();
  let n = 0;
  let i = 0;
  let idx: number;
  while ((idx = t.indexOf(q, i)) !== -1) {
    n++;
    i = idx + q.length;
  }
  return n;
}

/**
 * Wrap each match in a <mark> for rendering in React (list rows, subject line).
 * Returns the plain string untouched when there is no query or no match, so it
 * costs nothing on the common path.
 */
export function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;

  const ql = q.toLowerCase();
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let idx: number;
  let key = 0;

  while ((idx = lower.indexOf(ql, i)) !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      createElement("mark", { className: "hl-match", key: key++ }, text.slice(idx, idx + q.length)),
    );
    i = idx + q.length;
  }

  if (out.length === 0) return text;
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/**
 * Wrap matches inside an already-sanitized HTML body with <mark> elements.
 *
 * This runs only over text nodes -- never attributes or tag names -- and inserts
 * matches as freshly created text + <mark> nodes, so it cannot introduce markup
 * or reopen an injection hole in HTML that sanitize.ts has already cleaned. It
 * must run AFTER sanitisation, on its output, for that guarantee to hold.
 */
export function highlightHtml(html: string, query: string): { html: string; count: number } {
  const q = query.trim();
  if (!q) return { html, count: 0 };

  const doc = new DOMParser().parseFromString(html, "text/html");
  const ql = q.toLowerCase();

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    const parent = t.parentElement?.tagName;
    // Never touch text that isn't shown as prose, and never nest a mark in a mark.
    if (parent === "SCRIPT" || parent === "STYLE" || parent === "MARK") continue;
    if (t.data.toLowerCase().includes(ql)) targets.push(t);
  }

  let count = 0;
  for (const t of targets) {
    const data = t.data;
    const lower = data.toLowerCase();
    const frag = doc.createDocumentFragment();
    let i = 0;
    let idx: number;
    while ((idx = lower.indexOf(ql, i)) !== -1) {
      if (idx > i) frag.appendChild(doc.createTextNode(data.slice(i, idx)));
      const mark = doc.createElement("mark");
      mark.className = "mvh";
      mark.textContent = data.slice(idx, idx + q.length);
      frag.appendChild(mark);
      count++;
      i = idx + q.length;
    }
    if (i < data.length) frag.appendChild(doc.createTextNode(data.slice(i)));
    t.parentNode?.replaceChild(frag, t);
  }

  return { html: doc.body.innerHTML, count };
}
