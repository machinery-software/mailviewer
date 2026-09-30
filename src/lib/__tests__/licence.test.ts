import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: the project is typed for the browser and has no
// Node typings, and these are just three text files at the repository root.
import licence from "../../../LICENSE?raw";
import readme from "../../../README.md?raw";
import pkg from "../../../package.json";

/**
 * The repository says "MIT" in package.json and in the README. Saying it is
 * not the same as granting it: without the licence text there is nothing a
 * reader can rely on, and GitHub reports the project as unlicensed. This keeps
 * the three statements in step with each other.
 */
describe("licence", () => {
  it("ships the MIT licence text the package declares", () => {
    expect(licence.split("\n")[0]).toBe("MIT License");
    expect(licence).toMatch(/^Copyright \(c\) \d{4} \S/m);
    expect(licence).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy");
    expect(licence).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it("agrees with package.json and the README", () => {
    expect(pkg.license).toBe("MIT");
    expect(readme).toMatch(/## Licence\s+MIT\b/);
    // And the README points at the text, so a reader can find it.
    expect(readme).toContain("[`LICENSE`](LICENSE)");
  });
});
