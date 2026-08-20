import { useState } from "react";
import NetworkMonitor from "./NetworkMonitor";
import { attemptExfiltration, type ExfilTestResult } from "../lib/netguard";
import { Footer } from "./Footer";

export default function Verify() {
  const [result, setResult] = useState<ExfilTestResult | null>(null);
  const [running, setRunning] = useState(false);

  async function runTest() {
    setRunning(true);
    setResult(await attemptExfiltration());
    setRunning(false);
  }

  return (
    <>
      <section className="section section-narrow">
        <h2>Verification</h2>
        <h3>Check the claim yourself. It takes about ninety seconds.</h3>
        <p>
          We tell you your mail never leaves the browser. You have no reason to believe us.
          What follows is how to confirm it with Chrome's built-in DevTools — the same tools
          you'd use to catch us lying. Nothing here needs an extension, an account, or any
          trust in us at all.
        </p>
        <p>
          Do this with a real message file. The whole point is to watch what happens when
          the app is holding something you actually care about.
        </p>

        <div className="steps">
          <div className="step">
            <div>
              <h4>Open the Network panel before you open a file</h4>
              <p>
                Press <kbd>F12</kbd> (or <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>I</kbd> on a Mac)
                and choose the <b>Network</b> tab. Leave it open. If the list is empty,
                reload the page once so you can see the app's own files load — that's your
                baseline, and it tells you the panel is actually recording.
              </p>
              <p>
                Tick <b>Preserve log</b>. Now nothing can disappear on you, even if the page
                navigates.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>Read the baseline: everything is from this domain</h4>
              <p>
                Right-click the column headers and switch on the <b>Domain</b> column. Every
                row you see should show this site's own domain. Those rows are the
                HTML, JavaScript and CSS that make up the app.
              </p>
              <p>
                There is no analytics script, no font CDN, no error reporter, no tag manager.
                A page that phoned home would need a row here that isn't this domain — and
                you'd see it.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>Now open your mail file and watch nothing happen</h4>
              <p>
                Go to <a href="#/open">Open a file</a> and drop in your .eml, .msg, .mbox or
                .pst. Read it. Click through the folders, open attachments, switch to the raw
                source view.
              </p>
              <p>
                Watch the Network panel the whole time. <b>No new rows appear.</b> Not one.
                The file was read with the browser's own <code>File</code> API and parsed by
                JavaScript running on your machine — it was never sent anywhere, which is why
                there is nothing to see.
              </p>
              <p>
                Sort by <b>Size</b> if you like. An upload of your 400 MB PST would be
                impossible to hide in a list this short.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>Read the policy that makes it impossible</h4>
              <p>
                In the Network panel, click the very first request (the document itself),
                then open <b>Headers → Response Headers</b>. Find{" "}
                <code>content-security-policy</code>. You are looking for this fragment:
              </p>
              <pre className="code">
{`content-security-policy: default-src 'self'; script-src 'self';
  img-src 'self' data: blob:; `}<span className="hl">connect-src 'none'</span>{`;
  form-action 'none'; object-src 'none'; base-uri 'none'; …`}
              </pre>
              <p>
                <code>connect-src 'none'</code> is the load-bearing part. It instructs your
                browser to refuse every outbound connection this page tries to make —{" "}
                <code>fetch</code>, <code>XMLHttpRequest</code>, WebSocket,{" "}
                <code>EventSource</code>, <code>sendBeacon</code>. The rule is enforced by
                Chrome, not by us, so it holds even if our code is buggy or malicious.
              </p>
              <p>
                <code>form-action 'none'</code> closes the other classic exfiltration route:
                a form that POSTs somewhere. Together they leave the page no way out.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>Make us try to leak, and watch the browser stop us</h4>
              <p>
                Don't just read the policy — test it. The button below makes this page attempt
                a genuine <code>POST</code> to an external server. It should fail, loudly, and
                you should see the browser complain in the <b>Console</b> tab.
              </p>

              <button className="btn btn-primary" onClick={runTest} disabled={running}>
                {running ? "Trying…" : "Attempt to send data off this machine"}
              </button>

              {result && (
                <div className={`callout ${result.blocked ? "" : "bad"}`}>
                  <strong>{result.blocked ? "Blocked." : "NOT BLOCKED."}</strong>{" "}
                  {result.detail}
                </div>
              )}

              <p>
                Now open the <b>Console</b> tab. Chrome will have logged something like{" "}
                <code>
                  Refused to connect to 'https://example.com/…' because it violates the
                  following Content Security Policy directive: "connect-src 'none'"
                </code>
                . And crucially — look back at the Network panel. The request has no
                remote address and transferred nothing, because it was killed before a single
                packet left your machine.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>If you see a request to an analytics host, read this</h4>
              <p>
                Depending on where this page is hosted, you might spot a{" "}
                <b>blocked</b> or <b>failed</b> request to a domain like{" "}
                <code>static.cloudflareinsights.com</code> — a beacon the hosting platform
                injects at its edge, after our code has run. Don't panic: click it and look at
                the <b>Size</b> column. It transferred <b>0 bytes</b>, and the Console shows a{" "}
                <code>Content Security Policy</code> refusal for it.
              </p>
              <p>
                That is the guarantee working, not failing. The browser blocked the host's own
                beacon for exactly the same reason it would block this app trying to upload your
                mail. The live monitor below counts these separately: requests that{" "}
                <em>loaded</em> (our code) versus requests the browser <em>blocked</em>. The
                only number that would ever matter is a foreign request that actually
                transferred data — and there is a red banner waiting if that ever happens.
              </p>
            </div>
          </div>

          <div className="step">
            <div>
              <h4>The final test: pull the plug</h4>
              <p>
                Load this page, then disconnect from the internet — turn off Wi-Fi, or set the
                Network panel's throttling dropdown to <b>Offline</b>. Now open a mail file
                and read it.
              </p>
              <p>
                It works, completely, with no network at all. An app that was quietly
                uploading your mail could not possibly do that. This is the test that needs no
                interpretation.
              </p>
            </div>
          </div>
        </div>

        <div className="callout warn">
          <strong style={{ color: "var(--amber)" }}>One honest caveat.</strong> Verifying the
          page today doesn't verify it forever — we could ship different code tomorrow. That's
          true of every website. Your protections are that the source is public, the site is
          static with no server-side logic, and the check above takes ninety seconds and can be
          repeated any time. If you need a permanent guarantee, download the source, run{" "}
          <code>npm run build</code>, and open it from your own disk. It works identically
          offline.
        </div>
      </section>

      <hr className="rule" />

      <section className="section section-narrow">
        <h2>Live</h2>
        <h3>What this page has done since you opened it</h3>
        <p>
          The same data the Network panel shows you, read from inside the page with{" "}
          <code>PerformanceObserver</code>. It's here for convenience — DevTools is the source
          of truth, since this counter is our code and you have no reason to trust our code.
        </p>
        <div style={{ marginTop: 24 }}>
          <NetworkMonitor />
        </div>
      </section>

      <Footer
        note={
          <>
            Found a way to make this page leak data? That's a security bug — please 
            <a href="#/report">report it</a>.
          </>
        }
      />
    </>
  );
}
