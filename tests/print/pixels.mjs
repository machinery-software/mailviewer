// Reading colours off rendered pixels.
//
// A screenshot is decoded *in the browser under test* -- drawn to a canvas and
// read back -- rather than with a PNG library, so this adds no dependency and
// every engine reads its own output. What comes back is a histogram of exact
// colours, which is all the questions below need: what is the canvas, which
// colours does the text actually paint in, and how far apart are they.

/** Decode a PNG screenshot into a Map of 0xRRGGBB -> pixel count. */
export async function histogram(browser, png) {
  const page = await browser.newPage();
  try {
    const entries = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()];
    }, png.toString("base64"));
    return new Map(entries);
  } finally {
    await page.close();
  }
}

export const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const unpack = (key) => [key >> 16, (key >> 8) & 255, key & 255];
const distance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** WCAG 2 contrast ratio between two sRGB colours. */
export function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Colours closer than this count as "the same colour" -- rounding, not recolouring. */
export const SAME_COLOUR = 2;

export function analyse(counts) {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // A body is mostly canvas, so the commonest colour is what the text sits on.
  const backdrop = unpack(sorted[0][0]);
  return {
    backdrop,
    /** How many pixels paint in exactly this colour. Glyph cores do; blends do not. */
    pixelsOf(colour) {
      const target = typeof colour === "string" ? rgb(colour) : colour;
      let n = 0;
      for (const [key, count] of counts) if (distance(unpack(key), target) <= SAME_COLOUR) n += count;
      return n;
    },
    /**
     * The colour the text is painted in, for a body that declares none: of the
     * colours painted often enough to be glyph cores rather than anti-aliasing,
     * the one standing furthest from the canvas.
     */
    ink(minPixels = 20) {
      let best = backdrop;
      for (const [key, count] of sorted) {
        if (count < minPixels) break;
        const c = unpack(key);
        if (contrast(c, backdrop) > contrast(best, backdrop)) best = c;
      }
      return best;
    },
  };
}

export const sameColour = (a, b) => distance(a, b) <= SAME_COLOUR;
