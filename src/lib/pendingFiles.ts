/**
 * A one-shot hand-off for files chosen on the home page.
 *
 * The landing hero has its own drop area so the site reads as a tool, but the
 * actual reading happens on the viewer route. Rather than thread a File through
 * the hash router, the hero stashes it here and navigates; the viewer picks it
 * up once on mount. Deliberately module-scoped and consumed exactly once.
 */
let pending: File[] = [];

export function setPendingFiles(files: File[]): void {
  pending = files;
}

export function takePendingFiles(): File[] {
  const f = pending;
  pending = [];
  return f;
}
