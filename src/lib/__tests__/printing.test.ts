import { describe, expect, it } from "vitest";
import type { Message } from "../model";
import {
  PRINT_CONTENT_WIDTH_PX,
  PRINT_LIST_CAP,
  PRINT_PAGE_HEIGHT_PX,
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
