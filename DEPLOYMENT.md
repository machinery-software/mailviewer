# How mailviewer.app is actually deployed

Established 2026-08-17 by direct inspection of the Cloudflare account and the
live site. Every claim below has the command that produced it. Read-only
throughout — nothing in this investigation changed the deployment.

This document exists because the deployment model had previously been described
incorrectly (as a single self-contained HTML file served by a Worker script that
did a www→apex redirect and stamped security headers). **None of that is true.**
The corrections are noted inline.

---

## Summary

| | |
|---|---|
| **Model** | Cloudflare **Worker with static assets** — *not* Pages |
| **Worker/service name** | `mailviewer` |
| **Account** | Patchable Account, `c6d27821afe97f0f202dc4752dd916f6` |
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

The workflow this change set replaces had a step called *"Assert the privacy
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
replacement in `ci.yml` and `deploy.yml` strips comment lines before matching,
and was tested in both directions — it passes on the real file and fails on the
tampered one.

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

This means **the deployed artifact is verifiably the source in this repo at
`7d30a90`** — there is no drift between what is published and what can be read.
That is worth keeping true; it is the basis on which anyone can audit the
privacy claim.

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
`deploy.yml` workflow does exactly this.

If a gradual rollout is ever genuinely wanted, the prerequisite is making the
build a single self-contained document (inline all JS/CSS), not tuning the
split percentage.

---

## Appendix: what could not be determined

- **Whether the two GitHub secrets already exist** (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`) and what scopes the existing token has. Repository
  secret values are not readable via the API by design, and the current token
  was not exercised. The existing `deploy.yml` referenced both names, so they
  are presumed to exist — but the *scope* of the existing token is unverified,
  and it needs Workers scope rather than Pages scope. See `SETUP.md`.
- **Whether `wrangler versions upload` prints a preview URL in the exact format
  the workflow greps for.** The parsing is written defensively and warns rather
  than failing, but it could not be confirmed, because running `versions upload`
  would have mutated the account and this engagement was read-only.
