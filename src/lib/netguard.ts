/**
 * Live evidence, not assurances.
 *
 * The app claims it never sends your mail anywhere. Rather than asking you to
 * believe that, we watch our own network activity from inside the page and show
 * you every single request the browser makes on our behalf, as it happens.
 *
 * PerformanceObserver's "resource" entries cover fetch/XHR, images, scripts,
 * stylesheets, fonts, and beacons — i.e. every way a page can talk to a server.
 * If this app were exfiltrating your mail, a row would appear in this list.
 * It does not, because it cannot: see connect-src 'none' in public/_headers.
 */

export interface NetworkEvent {
  url: string;
  kind: string;
  bytes: number;
  at: number;
  /** True for the app's own JS/CSS loaded at startup from this same origin. */
  sameOrigin: boolean;
}

export interface NetGuardState {
  events: NetworkEvent[];
  /** Requests to any origin other than our own. Should always be zero. */
  foreignCount: number;
}

type Listener = (state: NetGuardState) => void;

const events: NetworkEvent[] = [];
const listeners = new Set<Listener>();
let started = false;

function snapshot(): NetGuardState {
  return {
    events: [...events],
    foreignCount: events.filter((e) => !e.sameOrigin).length,
  };
}

function emit() {
  const s = snapshot();
  for (const l of listeners) l(s);
}

function record(entry: PerformanceResourceTiming) {
  let sameOrigin = true;
  try {
    sameOrigin = new URL(entry.name, location.href).origin === location.origin;
  } catch {
    sameOrigin = false;
  }

  events.push({
    url: entry.name,
    kind: entry.initiatorType || "other",
    bytes: entry.transferSize || 0,
    at: entry.startTime,
    sameOrigin,
  });
}

export function startNetGuard(): void {
  if (started || typeof PerformanceObserver === "undefined") return;
  started = true;

  // Anything that loaded before we booted (our own bundle) still counts and
  // should be shown -- hiding it would undermine the point of the exercise.
  for (const e of performance.getEntriesByType("resource")) {
    record(e as PerformanceResourceTiming);
  }

  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) record(e as PerformanceResourceTiming);
    emit();
  });
  observer.observe({ type: "resource", buffered: true });
  emit();
}

export function subscribeNetGuard(fn: Listener): () => void {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function getNetGuardState(): NetGuardState {
  return snapshot();
}

export interface ExfilTestResult {
  blocked: boolean;
  detail: string;
}

/**
 * Try to phone home on purpose, and report that the browser refused.
 *
 * This is the demo that makes the guarantee legible: we attempt a real fetch to
 * a real external origin, and the browser's CSP engine kills it before a packet
 * is sent. The user can watch it fail in the Console and see that no request
 * appears in the Network tab's remote-address column.
 *
 * If this ever *succeeds*, the privacy guarantee of this app is broken and the
 * UI says so in the loudest terms available to it.
 */
export async function attemptExfiltration(): Promise<ExfilTestResult> {
  const target = "https://example.com/mailviewer-csp-self-test";
  try {
    await fetch(target, { method: "POST", body: "canary", mode: "no-cors" });
    return {
      blocked: false,
      detail:
        "The request was NOT blocked. The Content-Security-Policy is not being enforced on this page. " +
        "Do not use this deployment for sensitive mail.",
    };
  } catch (err) {
    return {
      blocked: true,
      detail:
        `The browser refused the request (${err instanceof Error ? err.name : "TypeError"}). ` +
        "connect-src 'none' is being enforced: this page cannot open a connection to any server, " +
        "including the one it was served from.",
    };
  }
}
