# CI/CD setup — manual steps

Everything in this file has to be done by hand by David, in the Cloudflare and
GitHub dashboards. None of it was done automatically: this change set adds
workflow files only, and **nothing in it takes effect until these steps are
completed**. Until then the workflows will fail at the Cloudflare steps, which
is the intended safe default.

The repository currently deploys via a workflow that calls `wrangler deploy` on
every push to `main`, with no human gate. Step 4 is what removes that.

---

## 1. Create a Cloudflare API token

**Cloudflare dashboard → My Profile → API Tokens → Create Token.**

Use **Create Custom Token**, not a template.

| Setting | Value |
|---|---|
| Token name | `mailviewer-github-actions` |
| Permissions | **Account** → **Workers Scripts** → **Edit** |
| Permissions | **Account** → **Account Settings** → **Read** |
| Account Resources | Include → **Patchable Account** |
| TTL | Your call; no expiry is simplest, an expiry is safer |

> ### ⚠️ Correction to the earlier draft
>
> The draft of this document specified **Account → Cloudflare Pages → Edit**.
> **That is the wrong permission and will not work.**
>
> `mailviewer` is not a Pages project — it is a Worker serving static assets
> (verified; see `DEPLOYMENT.md` §1). A Pages-scoped token cannot upload or
> deploy a Worker version. The permission needed is **Workers Scripts → Edit**.

Notes on scope:

- **Workers Scripts → Edit** is what `wrangler versions upload` and
  `wrangler versions deploy` need. This is the whole job.
- **Account Settings → Read** lets `wrangler whoami` resolve the account and
  produces better error messages. Strictly optional.
- You do **not** need Workers KV, R2, D1, or Queues — this Worker has no
  bindings at all (`"bindings": []`).
- You do **not** need **Zone → Workers Routes → Edit**. The apex custom domain
  is already attached and the workflows never modify routing. Leaving it off
  means a leaked token cannot repoint the domain.

Copy the token when it is shown. It is not retrievable afterwards.

---

## 2. Add the two GitHub secrets

**GitHub → repo → Settings → Secrets and variables → Actions → New repository
secret.**

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | `c6d27821afe97f0f202dc4752dd916f6` |

Both names are already referenced by the existing workflow, so they may exist
already. If so, **the token still needs replacing** unless you can confirm it
carries Workers Scripts → Edit rather than a Pages scope. Secret values cannot
be read back, so if you are not sure, rotate it.

---

## 3. Create the `production` environment with a required reviewer

This is the step that makes merging different from shipping.

**GitHub → repo → Settings → Environments → New environment.**

1. Name it exactly **`production`** — `deploy.yml` refers to it by that name.
2. Tick **Required reviewers** and add yourself.
3. *(Optional)* Under **Deployment branches and tags**, restrict to
   **Selected branches** → `main`, so no other branch can promote to production.
4. Save.

With this in place, a push to `main`:

- builds, typechecks, runs 237 tests, runs the privacy checks, and uploads a
  Worker version — **all unattended, and serving no traffic**;
- then **stops**, and waits for you to click **Review deployments → Approve** in
  the Actions tab before any user sees the change.

The upload job's summary gives you the preview URL to smoke-test *before* you
approve.

---

## 4. Remove the old auto-deploy path

The previous `deploy.yml` shipped straight to production on every push to `main`.
This change set replaces that file, so merging the PR is what removes it — no
separate action needed. Worth confirming after merge that there is no other
workflow calling `wrangler deploy`.

---

## 5. Branch protection with required checks

**GitHub → repo → Settings → Rules → Rulesets → New branch ruleset** (or
Settings → Branches → Add rule on older UI).

Target branch: `main`.

Enable:

- **Require a pull request before merging**
- **Require status checks to pass** → add:
  - `Typecheck, test, build, privacy checks`
- **Block force pushes**

That check name is the `name:` of the `verify` job in `ci.yml`. If you rename the
job, update the required check to match or merges will block on a check that can
never report.

> Do **not** add `Upload preview version` as a required check. It is skipped on
> PRs from forks by design, and a skipped required check blocks the merge.

---

## 6. Unrelated to CI, but found while checking: disable the Web Analytics beacon

`mailviewer.app` is currently serving a Cloudflare Web Analytics beacon script to
real browsers. It is injected at the edge, is not in this repo, and is invisible
to plain `curl` — it only appears when the request looks like a browser.

The CSP blocks it, so nothing leaks. But the app tells users to verify the
privacy claim in DevTools, and what they currently see there is a blocked
third-party tracker. Full detail and evidence in `DEPLOYMENT.md` §5a.

**Cloudflare dashboard → Web Analytics → mailviewer.app → disable Automatic
Setup** (or remove the site).

This cannot be automated: the Workers-scoped token in step 1 has no access to
zone analytics settings, by design.

Verify with a browser User-Agent — a bare `curl` will always look clean:

```bash
curl -sS -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  https://mailviewer.app/ | grep -c cloudflareinsights   # want: 0
```

This regressed once already — it was disabled on 2026-07-15 and is back — so it
is worth re-checking after any zone or DNS reconfiguration. The deploy workflow
now warns (but does not fail) when it detects the beacon after a release.

---

## Verifying it works

After all of the above, open a throwaway PR that changes only a comment:

1. **CI** runs: typecheck, tests, build, external-origin check, header check.
2. **Upload preview version** posts a comment with a `*.workers.dev` preview URL.
3. Open that URL, load a `.eml` and a `.msg`, and confirm in DevTools that the
   Network panel shows no third-party request. (Note: a preview is served from
   `*.workers.dev`, which is outside the zone, so it will look clean even while
   the apex is serving the beacon in step 6. A clean preview is not evidence
   about production here.)
4. Close the PR without merging.

Nothing in that sequence touches production.

---

## What this setup deliberately does not do

- **No gradual rollout / traffic splitting.** The build is not a single
  self-contained file — `index.html` points at content-hashed assets — so
  splitting traffic between two versions risks a user getting one version's HTML
  and another version's (missing) assets. `DEPLOYMENT.md` §7 explains this.
  Deploys go to 100% after a preview smoke-test instead.
- **No automatic rollback.** The health check fails the job loudly and prints the
  rollback command with the correct previous version ID, but a human decides.
  Reverting a privacy-critical app is not something to automate on a curl result.
