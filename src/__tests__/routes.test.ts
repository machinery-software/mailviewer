// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import App, { TITLES } from "../App";

/**
 * MAC-787: one document title per route, and the pages the footers link to
 * (Terms, Contact) exist and say what they are for.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(hash: string) {
  location.hash = hash;
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host!);
    root.render(createElement(App));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  location.hash = "";
});

describe("document titles", () => {
  it.each([
    ["#/", "Mailviewer"],
    ["#/open", "Open a file · Mailviewer"],
    ["#/privacy", "Privacy · Mailviewer"],
    ["#/verify", "Verify · Mailviewer"],
    ["#/report", "Report a problem · Mailviewer"],
    ["#/terms", "Terms · Mailviewer"],
    ["#/contact", "Contact · Mailviewer"],
  ])("%s is titled %s", (hash, title) => {
    mount(hash);
    expect(document.title).toBe(title);
  });

  it("changes the title when the route changes", () => {
    mount("#/");
    expect(document.title).toBe("Mailviewer");
    act(() => {
      location.hash = "#/privacy";
      dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(document.title).toBe(TITLES.privacy);
  });
});

describe("the terms page", () => {
  it("holds the web app's own terms, and points at the Mac terms on the release host rather than copying them", () => {
    const page = mount("#/terms");
    const text = page.textContent ?? "";
    expect(text).toContain("The web app is free, and these are its terms");
    expect(text).toContain("Provided as is");
    expect(text).toContain("MIT license");
    expect(text).not.toMatch(/Terms of sale|merchant of record|Refund policy/);
    const mac = [...page.querySelectorAll("a")].find((a) => a.getAttribute("href") === "https://updates.mailviewer.app/terms/");
    expect(mac?.textContent).toBe("updates.mailviewer.app/terms");
  });
});

describe("the contact page", () => {
  it("shows the support address with Copy Address and Open in Mail, like the Mac app's sheet", () => {
    const page = mount("#/contact");
    const cards = [...page.querySelectorAll(".contact-card")];
    expect(cards.map((c) => c.querySelector(".contact-addr")?.textContent)).toEqual([
      "support@mailviewer.app",
      "sales@mailviewer.app",
      "security@mailviewer.app",
    ]);
    const first = cards[0];
    expect(first.querySelector("a.btn")?.getAttribute("href")).toBe("mailto:support@mailviewer.app");
    // jsdom has no clipboard, and the Copy button is offered only where one exists.
    expect(first.querySelector("button")).toBeNull();
  });
});
