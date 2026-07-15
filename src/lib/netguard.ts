/**
 * Live evidence, not assurances.
 *
 * The app claims your mail never leaves the browser. Rather than asking you to
 * believe that, the page watches its own behaviour from the inside and shows you
 * two things as they happen:
 *
 *   1. Every resource that actually loaded -- via PerformanceObserver. On this
 *      page every one of them is same-origin: the app's own code.
 *
 *   2. Every request the browser BLOCKED -- via the `securitypolicyviolation`
 *      event, which the browser fires when the Content-Security-Policy stops a
 *      request. This is the browser itself reporting that it refused to talk to
 *      another server. It is the strongest evidence available, because it does
 *      not come from our code at all.
 *
 * The number that would mean trouble is a foreign request that actually
 * transferred bytes. That stays at zero -- and if it ever isn't, the UI says so
 * in the loudest terms it has.
 *
 * Why a blocked request is a GOOD sign: hosting platforms (Cloudflare among
 * them) sometimes inject their own analytics beacon into a page at the edge.
 * This app's CSP refuses it. When you see a blocked request to some analytics
 * host here, you are watching that refusal happen -- the same mechanism that
 * makes it impossible for the app to send your mail anywhere.
 */

export interface NetworkEvent {
  url: string;
  kind: string;
  /** Bytes actually transferred. 0 for a blocked or fully-cached resource. */
  bytes: number;
  at: number;
  sameOrigin: boolean;
}

export interface BlockedEvent {
  /** The origin the browser refused to reach (CSP truncates cross-origin URIs). */
  uri: string;
  /** e.g. "script-src", "img-src", "connect-src". */
  directive: string;
  at: number;
}

export interface NetGuardState {
  /** Resources that actually loaded. On this page: all same-origin, our code. */
  events: NetworkEvent[];
  /** Requests the browser blocked via CSP. Evidence the policy is enforced. */
  blocked: BlockedEvent[];
  /**
   * The one number that must be zero: a request to another origin that actually
   * transferred data. Not "attempted" -- succeeded. If this is non-zero, mail
   * could be leaving, and the UI must scream.
   */
  leakedCount: number;
}

type Listener = (state: NetGuardState) => void;

const events: NetworkEvent[] = [];
const blocked: BlockedEvent[] = [];
const listeners = new Set<Listener>();
let started = false;

function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    // A URL we can't even parse is not our origin; treat it as foreign.
    return false;
  }
}

/** Best guess at which directive stopped a resource, from how it was requested. */
function directiveForKind(kind: string): string {
  switch (kind) {
    case "script":
      return "script-src";
    case "img":
    case "image":
      return "img-src";
    case "css":
    case "link":
      return "style-src";
    case "fetch":
    case "xmlhttprequest":
    case "beacon":
      return "connect-src";
    default:
      return "the Content-Security-Policy";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url, location.href).host;
  } catch {
    return url;
  }
}

/**
 * Fold the two evidence sources into the three numbers the UI cares about.
 *
 * A foreign resource is decisive here *because* the CSP is so restrictive: every
 * directive is 'self' or 'none', so no cross-origin resource can actually load.
 * A foreign entry that shows 0 bytes was therefore blocked -- and the only way a
 * foreign entry could show real bytes is if the policy had failed, which is the
 * one thing worth alarming about.
 *
 * Exported and pure so the exact rule that decides "leaked" vs "blocked" can be
 * unit-tested without a browser -- it is the most safety-critical logic here.
 */
export function classify(events: NetworkEvent[], violations: BlockedEvent[]): NetGuardState {
  const loaded: NetworkEvent[] = [];
  let leakedCount = 0;
  // De-duplicate blocked requests by host: the same injected beacon often shows
  // up several times, and one row per destination is what a reader wants.
  const blockedByHost = new Map<string, BlockedEvent>();

  for (const e of events) {
    if (e.sameOrigin) {
      loaded.push(e);
    } else if (e.bytes > 0) {
      // Foreign AND real bytes moved: the policy did not hold. This is the alarm.
      leakedCount++;
      loaded.push(e);
    } else {
      // Foreign, nothing transferred: blocked by the CSP.
      const host = hostOf(e.url);
      if (!blockedByHost.has(host)) {
        blockedByHost.set(host, { uri: e.url, directive: directiveForKind(e.kind), at: e.at });
      }
    }
  }

  // The securitypolicyviolation event is authoritative about the directive, so
  // let it overwrite the guess we made from initiatorType.
  for (const b of violations) {
    blockedByHost.set(hostOf(b.uri), b);
  }

  return { events: loaded, blocked: [...blockedByHost.values()], leakedCount };
}

function snapshot(): NetGuardState {
  return classify(events, blocked);
}

function emit() {
  const s = snapshot();
  for (const l of listeners) l(s);
}

function recordResource(entry: PerformanceResourceTiming) {
  events.push({
    url: entry.name,
    kind: entry.initiatorType || "other",
    bytes: entry.transferSize || 0,
    at: entry.startTime,
    sameOrigin: isSameOrigin(entry.name),
  });
}

function recordViolation(e: SecurityPolicyViolationEvent) {
  // Only enforced (not report-only) violations mean a request was actually
  // stopped. "inline"/"eval" blockedURIs are about script execution, not a
  // network destination, so we keep only ones that name somewhere to connect to.
  if (e.disposition !== "enforce") return;
  const uri = e.blockedURI || "";
  if (!/^https?:/i.test(uri)) return;

  blocked.push({
    uri,
    directive: e.effectiveDirective || e.violatedDirective || "unknown",
    at: performance.now(),
  });
}

export function startNetGuard(): void {
  if (started) return;
  started = true;

  // The browser's own report that it refused a request. This is what turns an
  // injected third-party beacon from an embarrassment into a live demonstration.
  if (typeof document !== "undefined") {
    document.addEventListener("securitypolicyviolation", (e) => {
      recordViolation(e);
      emit();
    });
  }

  if (typeof PerformanceObserver !== "undefined") {
    // Anything that loaded before we booted (our own bundle) still counts and
    // should be shown -- hiding it would defeat the point of the exercise.
    for (const e of performance.getEntriesByType("resource")) {
      recordResource(e as PerformanceResourceTiming);
    }

    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) recordResource(e as PerformanceResourceTiming);
      emit();
    });
    observer.observe({ type: "resource", buffered: true });
  }

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
 * This is the demo that makes the guarantee legible: a real fetch to a real
 * external origin, which the browser's CSP engine kills before a packet is sent.
 * If it ever SUCCEEDS, the privacy guarantee is broken and the UI says so.
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
