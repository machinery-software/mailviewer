import { describe, expect, it } from "vitest";
import type { Message } from "../model";
import {
  PRINT_CONTENT_WIDTH_PX,
  PRINT_LIST_CAP,
  PRINT_PAGE_HEIGHT_PX,
  SAFARI_PDF_HINT,
  isMacSafari,
  listScopeLabel,
  messagesToPrint,
  printJobDescription,
} from "../printing";

function msg(id: string): Message {
  return {
    id,
    format: "eml",
    subject: `Subject ${id}`,
    replyTo: [], to: [], cc: [], bcc: [],
    date: null,
    references: [],
    attachments: [],
    headers: [],
    folderPath: [],
    flags: { hasAttachments: false },
  };
}

describe("messagesToPrint", () => {
  const listed = Array.from({ length: 5 }, (_, i) => msg(`m${i}`));

  it("prints just the selected message in message scope", () => {
    expect(messagesToPrint("message", listed[2], listed).map((m) => m.id)).toEqual(["m2"]);
  });

  it("prints nothing when message scope has no selection", () => {
    expect(messagesToPrint("message", null, listed)).toEqual([]);
  });

  it("prints the listed messages in list scope, in list order", () => {
    expect(messagesToPrint("list", listed[0], listed).map((m) => m.id))
      .toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("prints the list even when nothing is selected", () => {
    expect(messagesToPrint("list", null, listed)).toHaveLength(5);
  });

  // Rendering every message into its own frame at once means an unbounded job
  // against a large PST would take the browser down with it.
  it("caps a list job", () => {
    const many = Array.from({ length: PRINT_LIST_CAP + 40 }, (_, i) => msg(`m${i}`));
    const printed = messagesToPrint("list", null, many);
    expect(printed).toHaveLength(PRINT_LIST_CAP);
    expect(printed[0].id).toBe("m0");
    expect(printed.at(-1)?.id).toBe(`m${PRINT_LIST_CAP - 1}`);
  });
});

describe("listScopeLabel", () => {
  it("names the exact count so the choice is not a guess", () => {
    expect(listScopeLabel(1)).toBe("All 1 message listed");
    expect(listScopeLabel(12)).toBe("All 12 messages listed");
  });

  // A control that silently prints less than it says is the worst outcome for
  // someone producing an exhibit -- the cap has to be visible before the click.
  it("says so on the control itself when the cap will bite", () => {
    const label = listScopeLabel(PRINT_LIST_CAP + 1);
    expect(label).toContain(`First ${PRINT_LIST_CAP}`);
    expect(label).toContain(`${PRINT_LIST_CAP + 1}`);
  });
});

describe("printJobDescription", () => {
  it("states that a complete job is complete", () => {
    expect(printJobDescription(12, 12)).toBe(
      "Printed all 12 messages from the current view, newest first.",
    );
  });

  // And it is restated on the paper, because whoever reads the printout later
  // did not watch it being made.
  it("states the shortfall when a job was capped", () => {
    expect(printJobDescription(4000, PRINT_LIST_CAP)).toBe(
      `Printed ${PRINT_LIST_CAP} of 4,000 messages from the current view, newest first.`,
    );
  });
});

describe("PRINT_CONTENT_WIDTH_PX", () => {
  // Measuring narrower than the paper costs a little trailing whitespace;
  // measuring wider clips the bottom of the message off the page. Only one of
  // those is acceptable in a tool used to produce exhibits.
  it("is A4 less the 12mm print margins, which is narrower than US Letter", () => {
    const letterContentPx = Math.round(((215.9 - 24) / 25.4) * 96);
    expect(PRINT_CONTENT_WIDTH_PX).toBe(703);
    expect(PRINT_CONTENT_WIDTH_PX).toBeLessThan(letterContentPx);
  });
});

describe("PRINT_PAGE_HEIGHT_PX", () => {
  // A message body is free to size itself against the viewport, and whatever
  // the measuring frame is tall is what that CSS believes a page to be. This
  // was a 10px placeholder, which made a `100vh` body report ~64px of content
  // and print as one near-empty page regardless of how much text it held.
  it("is a plausible page, not a placeholder", () => {
    expect(PRINT_PAGE_HEIGHT_PX).toBe(1032);
    expect(PRINT_PAGE_HEIGHT_PX).toBeGreaterThan(PRINT_CONTENT_WIDTH_PX);
  });

  it("is A4's printable height, which is taller than US Letter's", () => {
    const letterPrintableHeightPx = Math.round(((279.4 - 24) / 25.4) * 96);
    expect(PRINT_PAGE_HEIGHT_PX).toBeGreaterThan(letterPrintableHeightPx);
  });
});

describe("isMacSafari", () => {
  // Real user-agent strings, current as of November 2026.
  const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
  const yes: Array<[string, string]> = [
    ["Safari 27 on macOS", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15`],
    ["Safari 18 on macOS", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15`],
    ["Safari Technology Preview", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.1 Safari/605.1.15`],
  ];
  const no: Array<[string, string, number?]> = [
    ["Chrome on macOS", `${MAC} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`],
    ["Edge on macOS", `${MAC} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0`],
    ["Opera on macOS", `${MAC} AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 OPR/140.0.0.0`],
    ["Firefox on macOS", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0"],
    ["Safari on iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1"],
    ["Safari on iPad, desktop mode", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15`, 5],
    ["Chrome on iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.0.0 Mobile/15E148 Safari/604.1"],
    ["Chrome on Windows", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"],
    ["Chrome on Android", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36"],
    ["headless Chrome", `${MAC} AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36`],
    ["a WKWebView with no Safari token", `${MAC} AppleWebKit/605.1.15 (KHTML, like Gecko)`],
    ["an empty user agent", ""],
  ];

  for (const [what, ua] of yes) {
    it(`is true for ${what}`, () => expect(isMacSafari(ua, 0)).toBe(true));
  }
  for (const [what, ua, touch] of no) {
    it(`is false for ${what}`, () => expect(isMacSafari(ua, touch ?? 0)).toBe(false));
  }

  it("names the menu exactly as Safari's print sheet does", () => {
    expect(SAFARI_PDF_HINT).toBe("In the print sheet, choose PDF ▸ Save as PDF.");
  });
});
