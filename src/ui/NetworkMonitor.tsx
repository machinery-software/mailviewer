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
 * Every row is a request the browser actually made. The rows you see are the
 * app's own JavaScript and CSS, fetched from this origin when the page loaded.
 * The number that matters is the second one, and it is zero.
 */
export default function NetworkMonitor({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<NetGuardState>({ events: [], foreignCount: 0 });

  useEffect(() => subscribeNetGuard(setState), []);

  const foreign = state.foreignCount;

  return (
    <div className="monitor">
      <div className="monitor-head">
        <span className="pulse" aria-hidden="true" />
        <span>Network activity · live</span>
        <span className="monitor-count">{state.events.length} total</span>
      </div>

      <div className="tally">
        <div className="tally-cell">
          <div className="tally-num neutral">{state.events.length}</div>
          <div className="tally-label">
            requests to this site, all of them the app's own code
          </div>
        </div>
        <div className="tally-cell">
          <div className={`tally-num ${foreign === 0 ? "zero" : "nonzero"}`}>{foreign}</div>
          <div className="tally-label">
            {foreign === 0
              ? "requests to anywhere else. This is the number that matters."
              : "requests to another server. Something is wrong — do not use this page."}
          </div>
        </div>
      </div>

      {!compact && (
        <div className="reqlist" role="log" aria-label="Network requests made by this page">
          {state.events.length === 0 && (
            <div className="req">
              <span className="req-url">Waiting for the first request…</span>
            </div>
          )}
          {state.events.map((e, i) => (
            <div className="req" key={`${e.url}-${i}`}>
              <span className={`req-origin ${e.sameOrigin ? "self" : "foreign"}`}>
                {e.sameOrigin ? "self" : hostOf(e.url)}
              </span>
              <span className="req-url" title={e.url}>
                {pathOf(e.url)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="monitor-foot">
        Counted in-page with <code>PerformanceObserver</code>. Don't take its word for it —{" "}
        <a href="#/verify">check it in DevTools</a>.
      </div>
    </div>
  );
}
