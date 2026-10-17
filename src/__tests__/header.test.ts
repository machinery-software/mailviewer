// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../App";

/** MAC-715: the web app's header links to the Mac app's page at /mac. */
describe("the site header", () => {
  it("links to Mailviewer for Mac at /mac, styled like the other header links", () => {
    const header = renderToStaticMarkup(createElement(App));
    const nav = header.slice(header.indexOf('<nav class="nav">'), header.indexOf("</nav>"));
    expect(nav).toContain('<a class="nav-link" href="/mac">Mailviewer for Mac</a>');
  });
});
