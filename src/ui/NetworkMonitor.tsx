import { useEffect, useState } from "react";
import { subscribeNetGuard, type NetGuardState } from "../lib/netguard";

function hostOf(url: string): string {
  try {
    return new URL(url, location.href).host;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url, location.href);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/**
 * The live network log of this very page.
 *
 * Two columns tell the whole story. On the left, requests that actually loaded
 * -- every one from this origin, the app's own code. On the right, requests the
 * browser BLOCKED under the CSP, which is the mechanism that also makes leaking
 * your mail impossible. The one number that would mean trouble -- a foreign
 * request that transferred real data -- has its own banner and stays at zero.
 */
export default function NetworkMonitor({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<NetGuardState>({ events: [], blocked: [], leakedCount: 0 });

  useEffect(() => subscribeNetGuard(setState), []);

  const loaded = state.events;
  const blocked = state.blocked;
  const leaked = state.leakedCount;

  return (
    <div className="monitor">
      <div className="monitor-head">
        <span className="pulse" aria-hidden="true" />
        <span>Network activity · live</span>
        <span className="monitor-count">{loaded.length} loaded</span>
      </div>

      {leaked > 0 && (
        <div className="monitor-alarm" role="alert">
          {leaked} request{leaked === 1 ? "" : "s"} sent data to another server. Something is
          wrong — do not use this page for sensitive mail.
        </div>
      )}

      <div className="tally">
        <div className="tally-cell">
          <div className="tally-num neutral">{loaded.length}</div>
          <div className="tally-label">
            requests that loaded — every one is this site's own code
          </div>
        </div>
        <div className="tally-cell">
          <div className={`tally-num ${blocked.length > 0 ? "good" : "neutral"}`}>
            {blocked.length}
          </div>
          <div className="tally-label">
            {blocked.length > 0
              ? "requests to another server, blocked by the browser before any data was sent"
              : "requests the browser had to block — none needed blocking yet"}
          </div>
        </div>
      </div>

      {!compact && (
        <div className="reqlist" role="log" aria-label="Network activity on this page">
          {blocked.map((b, i) => (
            <div className="req" key={`b-${b.uri}-${i}`}>
              <span className="req-origin blocked" title={`blocked by ${b.directive}`}>
                blocked
              </span>
              <span className="req-url" title={`${b.uri} — refused by ${b.directive}`}>
                {hostOf(b.uri)} · refused by {b.directive}
              </span>
            </div>
          ))}
          {loaded.map((e, i) => (
            <div className="req" key={`e-${e.url}-${i}`}>
              <span className={`req-origin ${e.sameOrigin ? "self" : "foreign"}`}>
                {e.sameOrigin ? "self" : hostOf(e.url)}
              </span>
              <span className="req-url" title={e.url}>
                {pathOf(e.url)}
              </span>
            </div>
          ))}
          {loaded.length === 0 && blocked.length === 0 && (
            <div className="req">
              <span className="req-url">Waiting for the first request…</span>
            </div>
          )}
        </div>
      )}

      <div className="monitor-foot">
        Read in-page with <code>PerformanceObserver</code> and the browser's{" "}
        <code>securitypolicyviolation</code> event. Don't take its word for it —{" "}
        <a href="#/verify">check it in DevTools</a>.
      </div>
    </div>
  );
}
