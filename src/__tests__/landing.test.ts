// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Landing from "../ui/Landing";

/** MAC-787: the home page points at the Mac app, and its grids divide evenly. */
describe("the home page", () => {
  const html = renderToStaticMarkup(createElement(Landing));

  it("has the Mac app card under the viewer's intro, linking to /mac", () => {
    const card = html.slice(html.indexOf('<a class="maccard"'), html.indexOf("</a>", html.indexOf('<a class="maccard"')));
    expect(card).toContain('href="/mac"');
    expect(card).toContain("Mailviewer for Mac");
    expect(card).toContain("The same viewer as a native app, with Quick Look, mailboxes and MDM deployment.");
    expect(card).toContain("Download free, license for teams");
    // It comes after the hero and before the formats.
    expect(html.indexOf('class="hero2"')).toBeLessThan(html.indexOf('class="maccard"'));
    expect(html.indexOf('class="maccard"')).toBeLessThan(html.indexOf("Formats"));
  });

  it("lays its cards out in column counts that divide them: 8 formats over 4, 3 privacy cards over 3", () => {
    const formats = (html.match(/class="feature format"/g) ?? []).length;
    const privacy = (html.match(/class="feature pcard"/g) ?? []).length;
    expect(formats).toBe(8);
    expect(privacy).toBe(3);
    expect(html).toContain('class="cards cards-4 formats"');
    expect(html).toContain('class="cards cards-3 privacy-cards"');
  });
});
