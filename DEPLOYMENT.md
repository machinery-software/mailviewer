# How mailviewer.app is actually deployed

Established 2026-08-17 by direct inspection of the Cloudflare account and the
live site. Every claim below has the command that produced it. Read-only
throughout — nothing in this investigation changed the deployment.

This document exists because the deployment model had previously been described
incorrectly (as a single self-contained HTML file served by a Worker script that
did a www→apex redirect and stamped security headers). **None of that is true.**
The corrections are noted inline.

It is reference documentation, not a pipeline. **Releases are made by hand** —
CI builds, tests and checks a change, and a person decides whether it ships. The
procedure is §8. Nothing in this repository holds a Cloudflare credential.

---

## Summary

| | |
|---|---|
| **Model** | Cloudflare **Worker with static assets** — *not* Pages |
| **Worker/service name** | `mailviewer` |
| **Account** | Patchable Account (id deliberately not recorded here — `wrangler whoami`) |
| **Worker script** | **None.** Assets-only; `main_module` is `null` |
| **Custom domain** | `mailviewer.app` (apex) only — no `www` |
| **Also public at** | `mailviewer.patchable-account.workers.dev` |
| **Live version** | `9b24838a-47b8-4516-84dd-92fc0f193eee` |
| **Deployed at** | 2026-07-15T12:55:44.353Z, 100% traffic |
| **Build** | `npm run build` → `dist/` |
| **Reproducible** | Yes — byte-identical to live |

---

## 1. Pages or Worker?

**Worker with static assets.** The Pages question — Direct Upload vs
Git-integrated — does not apply, because there is no Pages project.

`mailviewer` does not appear in the Pages project list:

```
$ npx wrangler pages project list
┌─────────────────────┬───────────────────────────────────────────────────────┬──────────────┬───────────────┐
│ Project Name        │ Project Domains                                       │ Git Provider │ Last Modified │
├─────────────────────┼───────────────────────────────────────────────────────┼──────────────┼───────────────┤
│ mixr-site           │ mixr-site-14p.pages.dev, getmixr.app                  │ Yes          │ 2 weeks ago   │
│ patchable           │ patchable.pages.dev, patchable.app, www.patchable.app │ No           │ 3 weeks ago   │
│ shft-marketing      │ shft-marketing.pages.dev, getshft.app                 │ Yes          │ 2 months ago  │
│ mngd-site           │ mngd-site.pages.dev, getmngd.com, mngd.app            │ Yes          │ 3 months ago  │
│ mngd-docs           │ mngd-docs.pages.dev, docs.mngd.app                    │ Yes          │ 3 months ago  │
│ machinery-marketing │ machinery-marketing.pages.dev, machinery.software     │ Yes          │ 3 months ago  │
│ patchable-marketing │ patchable-marketing.pages.dev                         │ Yes          │ 4 months ago  │
└─────────────────────┴───────────────────────────────────────────────────────┴──────────────┴───────────────┘
```

It does appear as a Worker, with version history:

```
$ npx wrangler deployments list --name mailviewer
...
Created:     2026-07-15T12:55:44.353Z
Author:      dtminnema@icloud.com
Source:      Unknown (deployment)
Version(s):  (100%) 9b24838a-47b8-4516-84dd-92fc0f193eee
```

### There is no Worker script

`wrangler.jsonc` has no `main` field, and the deployed version confirms it from
the server side:

```
$ curl .../workers/scripts/mailviewer/versions/9b24838a-...
{
  "success": true,
  "main_module": null,
  "modules": [],
  "bindings": [],
  "compat_date": "2026-07-14"
}
```

`main_module: null` with zero modules means Cloudflare serves the files in
`dist/` directly from its edge. **No server-side code runs on any request.**

**Correction:** there is no `src/index.js`, no Worker script of any kind, and
therefore no code doing a www→apex redirect or stamping headers. Headers come
from `public/_headers` (copied to `dist/_headers` at build time), which
Cloudflare's static-asset serving applies.

---

## 2. Custom domain

One Workers custom domain, on the **apex only**:

```
$ curl .../accounts/$ACC/workers/domains
{"id": "d91e72156a50700584b64af4be7d7415004c67f5",
 "zone_name": "mailviewer.app",
 "hostname": "mailviewer.app",
 "service": "mailviewer",
 "environment": "production"}
```

`www` does not exist at all — it has no DNS record, so there is nothing to
redirect:

```
$ curl -sSI https://www.mailviewer.app/
curl: (6) Could not resolve host: www.mailviewer.app

$ dig +short mailviewer.app A
104.21.28.94
172.67.145.79
```

**Correction:** the claimed www→apex redirect does not exist and never did.
Anyone typing `www.mailviewer.app` currently gets a DNS failure, not the site.
Whether that matters is a product call — it is recorded here as fact, not as a
recommendation.

### Second public hostname

The Worker is also reachable at `mailviewer.patchable-account.workers.dev`, and
it serves the identical build with the identical headers (same `etag`). This is
not a leak — the security headers apply there too — but it is a second public
surface for the same app, and it is what per-version preview URLs are built on.

```
$ curl .../accounts/$ACC/workers/scripts/mailviewer/subdomain
{"result": {"enabled": true, "previews_enabled": true}, "success": true}

$ curl .../accounts/$ACC/workers/subdomain
{"result": {"subdomain": "patchable-account"}, "success": true}
```

`previews_enabled: true` is what makes per-version preview URLs work, which the
CI workflows rely on.

---

## 3. Current live deployment and rollback window

| | |
|---|---|
| **Live version ID** | `9b24838a-47b8-4516-84dd-92fc0f193eee` |
| **Created** | 2026-07-15T12:55:43.919Z |
| **Deployed** | 2026-07-15T12:55:44.353Z at 100% |
| **Author** | dtminnema@icloud.com |

There are **8 versions and 8 deployments** in the account history, all from
14–15 July 2026:

```
$ npx wrangler versions list --name mailviewer | grep -c '^Version ID:'
8
$ npx wrangler deployments list --name mailviewer | grep -c '^Created:'
8
```

Cloudflare retains the most recent versions for rollback (documented limit: 100).
With only 8 versions in existence, **all 8 are currently rollback targets.**

### Rollback procedure

```bash
# 1. Find the version you want to go back to.
npx wrangler versions list --name mailviewer

# 2. Point 100% of traffic at it. This is instant and does not rebuild anything.
npx wrangler versions deploy <version-id>@100 --name mailviewer --yes

# 3. Confirm.
curl -sSI https://mailviewer.app/ | grep -i content-security-policy
```

Or in the dashboard: **Workers & Pages → mailviewer → Deployments → Rollback**.

The deploy workflow records the outgoing version ID in the run log and the run
summary *before* it deploys, so the rollback target for any release is in that
run's summary.

---

## 4. Headers: served vs. declared

**Zero drift.** All seven headers declared in `public/_headers` are served
exactly as written:

```
content-security-policy          MATCH
referrer-policy                  MATCH
permissions-policy               MATCH
x-content-type-options           MATCH
cross-origin-opener-policy       MATCH
cross-origin-resource-policy     MATCH
strict-transport-security        MATCH
```

The served CSP, in full:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:;
connect-src 'none'; frame-src 'self' blob:; child-src 'self' blob:;
worker-src 'self' blob:; form-action 'none'; object-src 'none'; base-uri 'none';
frame-ancestors 'none'; upgrade-insecure-requests
```

**Correction:** the CSP *does* contain an explicit `connect-src 'none'`. It had
been described as having no `connect-src` and falling through to
`default-src 'none'`; neither half of that is accurate — `default-src` is
`'self'`, not `'none'`, so the explicit `connect-src 'none'` is doing real work
and must not be removed on the theory that `default-src` covers it.

### Two headers on the response that are *not* in `public/_headers`

```
report-to: {"group":"cf-nel","max_age":604800,
            "endpoints":[{"url":"https://a.nel.cloudflare.com/report/v4?s=..."}]}
nel:       {"report_to":"cf-nel","success_fraction":0.0,"max_age":604800}
```

These are Cloudflare's Network Error Logging, injected at the edge. Worth
understanding precisely, given what this app promises:

- NEL reports are sent by the **browser's networking stack**, not by page
  JavaScript, so `connect-src 'none'` does **not** block them. This is the one
  egress channel on the page that the CSP cannot close.
- `success_fraction: 0.0` means successful requests are never reported. Only
  network *failures* are.
- A NEL report contains the request URL, timing and an error type. **No message
  content can reach it** — mail is parsed in a Web Worker and never becomes a
  network request in the first place.

So this is not a mail-privacy leak, and the "your messages never leave the
browser" claim holds. It is, however, third-party telemetry on a page whose
pitch is zero egress, and it is not currently disclosed anywhere. If David wants
it gone, it is a per-zone Cloudflare setting (Network Error Logging), not a code
change. Flagged, not fixed.

---

### The previous CI privacy guard did not work

The workflow this change set deletes had a step called *"Assert the privacy
policy is intact"*, whose job was to fail the deploy if `connect-src 'none'` were
ever removed from the headers. It did this:

```bash
grep -q "connect-src 'none'" dist/_headers || { ...refuse to deploy... }
```

`public/_headers` documents every CSP directive in a comment block above the real
header. Line 7 is:

```
  #   connect-src 'none'      fetch(), XMLHttpRequest, WebSocket, EventSource
```

so the grep matches the **comment**, not the policy. Verified by deleting
`connect-src 'none'` from the actual `Content-Security-Policy:` line (line 21)
and re-running the original check: **it passed.**

The guard would not have caught the one thing it existed to catch. The
replacement lives in `ci.yml` and strips comment lines before matching, so it
tests the policy rather than the prose describing it. It was checked in both
directions against the tampered file above: the corrected guard refuses it, and
the original guard passes it.

Nothing was actually shipped with a broken CSP; the live headers are correct
(§4). This was a latent hole in the safety net, not an incident.

---

## 5. Build reproducibility

**Confirmed byte-identical.** A clean `npm ci && npm run build` from commit
`7d30a90` produces exactly what is being served right now:

| File | SHA-256 | Live? |
|---|---|---|
| `dist/index.html` | `540201c5f60c3bf5f7a38071160823eda378c3adcbac029c5bd95f13f0b93d02` | ✅ |
| `dist/favicon.svg` | `7c26c9a1628c8e891999b7fb293652d6beedfc78fea48284b9c00ea706039164` | ✅ |
| `dist/assets/index-D1vh0toR.css` | `53d290c67fc91e05bf46f5a1b9168440b82489bba70f2e27dfa78b29744c8006` | ✅ |
| `dist/assets/index-LhpnWc-M.js` | `66138c2e6507f6541f057821fc354405bdd5b1cba0ff8ad4f5cb0032adda7ae1` | ✅ |
| `dist/assets/parse.worker-Cia_bjjg.js` | `60f8cb55151798b14dbf2d3219a47f0c4dc52cd261d6831a1bbdd2ad1d463c28` | ✅ |
| `dist/assets/react-DseiLK4y.js` | `35b5e6c468078e4049450eef6e2c59d8f6084cb99bb14c59bfe0ec6ce9df7e05` | ✅ |
| `dist/_headers` | `9136cd3ca27484b3ef4ff73f7fb01fc0e10d352ceff89b855abc7f5164e9d4f7` | (identical to `public/_headers`) |

Each live file was fetched from `https://mailviewer.app/...` and hashed; the
served `index.html` was also `diff`ed against the built one and is identical.

This means **the stored artifact is verifiably the source in this repo at
`7d30a90`** — the files Cloudflare holds are exactly the files this repo builds.
That is worth keeping true; it is the basis on which anyone can audit the
privacy claim.

> ⚠️ **What a browser actually receives is not this.** The zone injects an extra
> `<script>` tag into the HTML response for browser requests. The hashes above
> describe the *stored* artifact, not the *delivered* page. See §5a.

---

## 5a. The zone injects a Cloudflare Web Analytics beacon

**Status: live right now, on the apex domain, as of 2026-08-17.**

`mailviewer.app` serves a different HTML body depending on who asks:

```bash
$ curl -sS https://mailviewer.app/ | wc -c
1116                                   # matches dist/index.html exactly

$ curl -sS -A "Mozilla/5.0 ... Chrome/120.0 ..." https://mailviewer.app/ | wc -c
1475                                   # 359 bytes larger
```

The difference is a script tag appended before `</body>`:

```html
<script type="module"
  src="https://static.cloudflareinsights.com/beacon.min.js/v4513226cdae..."
  integrity="sha512-ZE9pZaUXND66v380QUtch/5sE9tPFh2zg45pR2PB0CVkCtOREv2AJKkSidISWkysEuQ0EH8faUU5du78bx87UQ=="
  data-cf-beacon='{"version":"2024.11.0","token":"bbb3d07a919744cc9291acd33a368be7","r":1}'
  crossorigin="anonymous"></script>
```

This is Cloudflare **Web Analytics → Automatic Setup**, injected at the edge. It
is not in this repo, not in `dist/`, and not in `_headers`.

### Does it leak anything?

**No.** The served CSP is `script-src 'self'`, and
`static.cloudflareinsights.com` is not `'self'`, so the browser refuses to load
or execute it. Nothing is transferred and no analytics are collected.

### Then why does it matter?

Because the product's pitch is *"nothing leaves your browser — verify it
yourself in DevTools."* A claims or legal user who does exactly that sees a
third-party tracking script in their Network panel, flagged red. The app's own
network monitor treats it as a foreign request. The CSP holding is the *correct*
outcome, but "we tried to load a tracker and were blocked" is not the story this
tool wants to tell about itself.

This was found and disabled once before, on 2026-07-15. It has regressed.

### It is invisible from CI and from previews

Two independent reasons a check would miss it:

1. **Plain `curl` does not trigger it.** Injection is keyed on the request
   looking like a browser. Every non-browser health check sees the clean
   1116-byte body, so no curl-based check can catch this — one reason there is
   no automated post-release health check here pretending otherwise.
2. **`workers.dev` is not affected.** Injection is zone-level, and the
   `*.workers.dev` hostname is not in the zone:

   ```bash
   $ curl -sS -A "Mozilla/5.0 ... Chrome/120.0 ..." \
       https://mailviewer.patchable-account.workers.dev/ | wc -c
   1116                               # clean
   ```

   **Per-version preview URLs live on `workers.dev`.** So smoke-testing a preview
   will never reveal this, however carefully it is done. Preview clean and
   production dirty is the expected state until the zone setting changes.

### Fixing it

Dashboard only — the Workers-scoped API token cannot change zone analytics
settings:

**Cloudflare dashboard → Web Analytics → mailviewer.app → disable Automatic
Setup** (or remove the site).

Verify with a browser User-Agent, not a bare curl:

```bash
curl -sS -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  https://mailviewer.app/ | grep -c cloudflareinsights   # want: 0
```

**Correction:** the build is *not* a single self-contained HTML file. It is a
1,116-byte `index.html` referencing four content-hashed assets. This matters for
release strategy — see the warning below.

---

## 6. Build command, output, Node version

| | |
|---|---|
| **Install** | `npm ci` |
| **Build** | `npm run build` (= `tsc --noEmit && vite build`) |
| **Output dir** | `dist/` |
| **Test** | `npm test` (= `vitest run`) — 237 tests in 18 files, all passing |

**Node is not pinned in the repo.** There is no `.nvmrc`, no `.node-version`,
and no `engines` field in `package.json`. The workflows use Node 22 by
convention. The byte-identical reproduction above was performed on Node
**v24.14.0 / npm 11.9.0**, which is evidence the build is not sensitive to the
Node major version across 22–24. Pinning it would still be an improvement; it is
not done here because this change set is deliberately scoped to CI.

---

## 7. A warning about gradual rollout

Because the build is **not** self-contained, `index.html` references
content-hashed asset filenames such as `/assets/index-LhpnWc-M.js`.

A percentage-based traffic split between two versions is therefore **not** safe
in the way it would be for a single inlined document. A user can receive the new
version's HTML while a subsequent request for its asset is answered by the old
version's asset set, producing a 404 and a blank page.

Recommendation: **deploy at `@100`, not in stages.** Smoke-test on the
per-version preview URL first — that gives a complete, self-consistent version
to test against with no split-traffic hazard — then promote in one step. The
procedure in §8 does exactly this.

If a gradual rollout is ever genuinely wanted, the prerequisite is making the
build a single self-contained document (inline all JS/CSS), not tuning the
split percentage.

---

## 8. Releasing

Deploying is a manual act. CI decides whether a change is *fit* to release; a
person decides whether it *is* released. There is no workflow, no token and no
`production` environment gate in this repository, because there is no automated
path to production for a gate to stand in front of.

That is a deliberate trade. It costs a few minutes per release. It buys: no
Cloudflare credential in GitHub to leak, mis-scope or rotate; no way for a merge
to reach real users while nobody is looking; and — for an app whose entire claim
is that it cannot send your mail anywhere — no machinery that could ship a
broken CSP to production without a human having looked at the thing first.

### Before you start

You need `wrangler` authenticated against the account. `npx wrangler login` is
the interactive path; `CLOUDFLARE_API_TOKEN` in your own shell works too. The
token needs **Account → Workers Scripts → Edit** — *not* the Pages scope an
earlier draft of this document specified, because `mailviewer` is a Worker with
static assets and not a Pages project (§1). It needs no KV, R2, D1 or Queues
permissions: this Worker has no bindings at all.

### 1. Check CI is green on the commit you intend to ship

Build, typecheck, tests, the external-origin tripwire and the CSP header checks
all run in `ci.yml` on every PR and on `main`. Do not skip this and hand-verify:
the header check in particular catches a class of mistake that is invisible by
eye (§4).

### 2. Build and upload a version that serves no traffic

```bash
git switch main && git pull
npm ci
npm run build
npx wrangler versions upload --message "$(git rev-parse --short HEAD)"
```

`versions upload` is specifically the no-traffic half of a deploy: the version
exists and gets its own preview URL, and the live deployment is untouched.

Read the preview URL out of wrangler's output rather than constructing it — the
version-prefix scheme is wrangler's to choose. Note the version id it prints;
step 4 needs it.

### 3. Smoke-test the preview

Open the preview URL and actually use it: load a `.eml`, a `.msg` and a `.pst`;
confirm the Network panel shows no third-party request; confirm the CSP
self-test on the privacy page still reports the fetch as blocked; print a
message to PDF and check the last page is there.

> **A preview cannot tell you anything about the analytics beacon (§5a).**
> Preview URLs live on `*.workers.dev`, which is outside the zone, so a preview
> is clean whether or not the apex is injecting a beacon. Check that against
> production, with a browser User-Agent, after the release.

### 4. Promote it

```bash
npx wrangler versions deploy <version-id>@100 --name mailviewer --yes
```

**`@100`, not a percentage split.** The build is not self-contained —
`index.html` points at content-hashed assets — so splitting traffic between two
versions can hand a user the new HTML and the old asset set, which is a blank
page. §7 has the detail.

### 5. Confirm, with a browser User-Agent

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
(KHTML, like Gecko) Chrome/120.0 Safari/537.36"

curl -sS -D- -o/dev/null -A "$UA" https://mailviewer.app/ | grep -i 'content-security-policy'
curl -sS -A "$UA" https://mailviewer.app/ | grep -c cloudflareinsights   # want: 0
```

The User-Agent matters. A bare `curl` always looks clean, which is exactly how
the beacon in §5a went unnoticed through a whole round of checking.

If something is wrong, the rollback procedure is §3 — it is instant and does not
rebuild anything.

---

## 9. Repository settings worth having

Not required for any of the above to work, and not something this repository can
configure for itself.

**Branch protection on `main`** — Settings → Rules → Rulesets:

- Require a pull request before merging
- Require status checks to pass → **`Typecheck, test, build, privacy checks`**
- Block force pushes

That check name is the `name:` of the `verify` job in `ci.yml`. Rename the job
and the required check silently stops matching, which blocks every merge on a
check that can never report.

**Disable the Cloudflare Web Analytics beacon** on the `mailviewer.app` zone —
see §5a for what it is, why it is not a leak, and why it is still worth removing
from a page that invites people to verify it in DevTools. It has regressed once
already, so it is worth re-checking after any zone or DNS reconfiguration.

---

## Appendix: what could not be determined

- **Whether `wrangler versions upload` prints a per-version preview URL in a
  predictable format.** Never exercised: running it would have mutated the
  account, and that engagement was read-only. §8 says to read the URL out of
  wrangler's own output rather than construct it, because the version-prefix
  scheme is wrangler's to choose and not something to hardcode.
- **Whether any `CLOUDFLARE_*` repository secrets still exist.** Secret values
  are not readable via the API by design. Nothing in this repository references
  them any more, so any that remain are unused — worth deleting rather than
  leaving a live credential around with nothing watching it.
