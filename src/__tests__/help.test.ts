// `?raw` rather than node:fs: the project is typed for the browser (see
// lib/__tests__/licence.test.ts).
import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import footer from "../ui/Footer.tsx?raw";
import helpSource from "../ui/Help.tsx?raw";
import { MAC_HELP_URL } from "../ui/Help";

/**
 * #/help (2026-10-24): the viewer's own help, trimmed to what the browser
 * version does, reachable from the footer of every page, and pointing at
 * the Mac app's guide for the parts that need a Mac.
 */
describe("the help page", () => {
  it("is a route of its own, rendered by App", () => {
    expect(app).toContain('if (h === "help") return "help";');
    expect(app).toContain('{route === "help" && <Help />}');
  });

  it("is linked from the footer of every page", () => {
    expect(footer).toContain('<a href="#/help">Help</a>');
  });

  it("covers what the browser version does, and sends Mac users to the Mac guide", () => {
    const help = helpSource.replace(/\/\*\*[\s\S]*?\*\//g, "");
    for (const phrase of ["Open a file", "Read a message", "Search", "Attachments", "Print, or save as PDF", "Keyboard shortcuts", "Something did not open", 'href="#/privacy"', 'href="#/report"']) {
      expect(help).toContain(phrase);
    }
    expect(MAC_HELP_URL).toBe("https://updates.mailviewer.app/help/");
    // Nothing the browser version does not have.
    for (const notHere of ["Quick Look", "Space bar", "inspector", "⌃⌘S", "Finder"]) {
      expect(help.replace(/<div className="callout">[\s\S]*?<\/div>/, "")).not.toContain(notHere);
    }
  });
});
