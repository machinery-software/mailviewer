import { describe, expect, it } from "vitest";
import { ISSUES_URL, SOURCE_URL } from "../config";

/**
 * The repository moved from a personal account to the organisation. GitHub
 * redirects the old path, but every link the site shows should name the
 * canonical one -- and be the one place the issues link derives from.
 */
describe("public source links", () => {
  it("point at the canonical repository", () => {
    expect(SOURCE_URL).toBe("https://github.com/machinery-software/mailviewer");
    expect(ISSUES_URL).toBe("https://github.com/machinery-software/mailviewer/issues");
  });
});
