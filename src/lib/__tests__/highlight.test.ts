/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { countMatches, highlightHtml } from "../highlight";

describe("countMatches", () => {
  it("counts case-insensitively", () => {
    expect(countMatches("Report on the report", "report")).toBe(2);
  });

  it("is empty-safe", () => {
    expect(countMatches(undefined, "x")).toBe(0);
    expect(countMatches("anything", "  ")).toBe(0);
    expect(countMatches("", "x")).toBe(0);
  });

  it("treats the query literally, not as a regex", () => {
    expect(countMatches("a.b and axb", "a.b")).toBe(1);
  });
});

describe("highlightHtml", () => {
  it("wraps matches in <mark> and counts them", () => {
    const { html, count } = highlightHtml("<p>the quick brown fox</p>", "quick");
    expect(count).toBe(1);
    expect(html).toContain('<mark class="mvh">quick</mark>');
  });

  it("matches across case but preserves the original casing", () => {
    const { html } = highlightHtml("<p>Invoice INVOICE invoice</p>", "invoice");
    expect(html).toContain("<mark class=\"mvh\">Invoice</mark>");
    expect(html).toContain("<mark class=\"mvh\">INVOICE</mark>");
  });

  it("highlights visible text only, never attribute values", () => {
    // "link" appears in the visible text but not in the href, so the href must
    // come through untouched while the text gets a mark.
    const { html, count } = highlightHtml('<a href="https://ex.example/x">a link here</a>', "link");
    expect(count).toBe(1);
    expect(html).toContain('href="https://ex.example/x"');
    expect(html).toContain('<mark class="mvh">link</mark>');
  });

  it("does not match text that only appears inside an attribute", () => {
    // "secret" is only in the href, never in visible text -> no marks at all.
    const { html, count } = highlightHtml('<a href="https://secret.example">click</a>', "secret");
    expect(count).toBe(0);
    expect(html).not.toContain("<mark");
    expect(html).toContain('href="https://secret.example"');
  });

  it("cannot introduce markup from the query — the match text is escaped", () => {
    // The body contains a literal (already-escaped) angle-bracket sequence. A
    // naive string replace could reopen an injection; DOM-based wrapping can't.
    const { html } = highlightHtml("<p>click &lt;script&gt; here</p>", "script");
    // The match is wrapped, but no live <script> element is created.
    expect(html).toContain("<mark");
    expect(html.toLowerCase()).not.toContain("<script>");
  });

  it("returns the input unchanged when the query is blank", () => {
    const input = "<p>untouched</p>";
    expect(highlightHtml(input, "")).toEqual({ html: input, count: 0 });
  });
});
