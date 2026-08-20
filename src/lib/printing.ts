import type { Message } from "./model";

/**
 * The width, in CSS pixels, that message bodies are measured and laid out at
 * for printing.
 *
 * A4 (210mm) less the 12mm page margins declared in the print stylesheet, at
 * the CSS reference resolution of 96dpi. US Letter is wider, so a page measured
 * at this width and printed on Letter reflows slightly shorter than measured.
 * That direction matters: measuring too narrow costs a little trailing
 * whitespace, measuring too wide clips the bottom of the message off the page,
 * and this tool exists to produce exhibits that are not missing their last
 * paragraph.
 */
export const PRINT_CONTENT_WIDTH_PX = Math.round(((210 - 24) / 25.4) * 96);

/**
 * The height, in CSS pixels, of the printable area of one page.
 *
 * A4 (297mm) less the 12mm margins, at 96dpi. This is the *viewport* the
 * measuring frame is given, and it has to be a plausible page rather than a
 * convenient placeholder: a message body is free to size itself against the
 * viewport -- `height: 100vh`, `position: absolute` pinned top-to-bottom,
 * `position: fixed` -- and whatever the frame is tall, that CSS believes a page
 * is. Measured inside a 10px-tall frame, such a body reports about 64px of
 * content and prints as a single near-empty page no matter how much text it
 * holds.
 *
 * US Letter's printable height is shorter, so a body pinned to the viewport
 * measures slightly taller than it will print and gains a little trailing
 * space. That is the safe direction, the same way PRINT_CONTENT_WIDTH_PX
 * measures narrow.
 */
export const PRINT_PAGE_HEIGHT_PX = Math.round(((297 - 24) / 25.4) * 96);

/**
 * The most messages a single print job will render.
 *
 * Printing renders every message into its own frame at once, so an unbounded
 * "print everything" against a 40,000-message PST would take the browser down.
 * The cap is surfaced in the UI label and stated again on the printed page --
 * an exhibit that quietly stops short of what was asked for is worse than one
 * that never claimed to be complete.
 */
export const PRINT_LIST_CAP = 100;

export type PrintScope = "message" | "list";

/** The messages a given scope will print, in the order they will appear. */
export function messagesToPrint(
  scope: PrintScope,
  selected: Message | null,
  listed: Message[],
): Message[] {
  if (scope === "message") return selected ? [selected] : [];
  return listed.slice(0, PRINT_LIST_CAP);
}

/** The label for the "print everything listed" control, cap included. */
export function listScopeLabel(listedCount: number): string {
  if (listedCount > PRINT_LIST_CAP) {
    return `First ${PRINT_LIST_CAP} of ${listedCount.toLocaleString()} messages listed`;
  }
  return `All ${listedCount.toLocaleString()} message${listedCount === 1 ? "" : "s"} listed`;
}

/**
 * The line printed at the top of a multi-message job, describing exactly what
 * the artifact contains. A printed exhibit should be self-describing: whoever
 * reads it later did not watch it being produced.
 */
export function printJobDescription(listedCount: number, printedCount: number): string {
  const of = listedCount === printedCount
    ? `all ${printedCount.toLocaleString()} messages`
    : `${printedCount.toLocaleString()} of ${listedCount.toLocaleString()} messages`;
  return `Printed ${of} from the current view, newest first.`;
}

/** Resolve after the next frame, so a just-mounted element has been laid out. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * The full rendered height of a message body, measured off-screen.
 *
 * The frame that actually *displays* a message body is sandboxed with no
 * `allow-same-origin`, which gives it an opaque origin and means the parent
 * cannot read `contentDocument.scrollHeight` from it -- deliberately, and it
 * stays that way. Adding `allow-same-origin` to the display frame to make
 * measurement convenient would hand every untrusted mail body a same-origin
 * handle back into the app.
 *
 * So the measurement happens in a separate frame that is never displayed and is
 * torn down immediately. It gets `allow-same-origin` so the parent can read it,
 * and pointedly not `allow-scripts`: with scripting withheld the document is
 * inert, so sharing an origin with it grants nothing to anybody.
 *
 * Images are awaited rather than assumed. Inline mail images are data: URLs,
 * which still decode asynchronously, so a synchronous measurement reports the
 * height of a message whose photographs have not arrived yet -- and a photo
 * spread is exactly the mail people print.
 */
export async function measureBodyHeight(
  srcDoc: string,
  width = PRINT_CONTENT_WIDTH_PX,
  timeoutMs = 8000,
  height = PRINT_PAGE_HEIGHT_PX,
): Promise<number> {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  // Sized to a page, not to a placeholder: see PRINT_PAGE_HEIGHT_PX. The frame
  // is clipped by a zero-size wrapper rather than pushed off-screen, so that a
  // body which overflows it horizontally -- and they do -- cannot paint into
  // the app while it is being measured.
  const clip = document.createElement("div");
  clip.setAttribute("aria-hidden", "true");
  clip.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;";
  frame.style.cssText =
    `width:${width}px;height:${height}px;border:0;visibility:hidden;`;
  clip.appendChild(frame);

  // srcdoc is set *before* the frame is inserted, and this ordering is
  // load-bearing. Inserting an iframe with nothing in it fires a `load` for the
  // initial about:blank document; a listener attached first would be woken by
  // that, measure a blank page, and report the frame's placeholder height as
  // the height of the message. Setting srcdoc up front means the only document
  // the frame ever loads is the one we care about.
  frame.srcdoc = srcDoc;

  const done = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });

  document.body.appendChild(clip);

  try {
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
    const doc = frame.contentDocument;
    if (!doc) return 0;

    const images = [...doc.images].map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
    );
    await Promise.race([
      Promise.all(images),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
    await nextFrame();

    const el = frame.contentDocument?.documentElement;
    const body = frame.contentDocument?.body;
    if (!el) return 0;
    // scrollHeight on either box can be the larger one depending on how the
    // message's own CSS lays itself out; take whichever is taller.
    return Math.max(el.scrollHeight, body?.scrollHeight ?? 0);
  } finally {
    clip.remove();
  }
}
