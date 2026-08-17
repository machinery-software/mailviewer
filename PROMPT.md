# Engagement brief

Scoped task, two parts: establish ground truth about how `mailviewer.app` is
deployed, then adapt the draft CI workflows to match it. Read-only on
infrastructure throughout.

## Hard rules

- **Never deploy.** No `wrangler deploy`, `wrangler pages deploy`, or
  `wrangler rollback`. No dashboard changes. There are real users on this site.
  Read-only commands only.
- **Never self-merge.** Output is a PR for David.
- Treat the draft `ci.yml`, `deploy.yml` and `SETUP.md` as **unverified**,
  written from an incorrect mental model of this repo. The same author had
  previously described the project as a single self-contained HTML file served
  by a Worker script — already established to be wrong. Verify every factual
  claim against the repo and the Cloudflare account before keeping it. Delete or
  rewrite anything that does not hold.

## Part 1 — Ground truth

Determine, with evidence, how `mailviewer.app` is actually deployed, citing the
command output behind each conclusion:

- Pages project or Worker with static assets? If Pages, Direct Upload or
  Git-integrated? (Direct Upload cannot be converted without recreating the
  project, and the apex domain is attached to the live one.)
- The exact project name as Cloudflare knows it.
- The ID and timestamp of the currently live deployment, and how many prior
  deployments are retained. This is the rollback target; record it.
- How the custom domain is attached — apex, www, both — and whether www
  redirects or serves independently.
- The actual headers served, compared against `public/_headers`. Flag drift.
- Whether `dist/` from a clean `npm ci && npm run build` is byte-identical to
  what is live. Record the hashes; this is the baseline.
- The build command, output directory, and expected Node version.

Anything that cannot be determined with the available credentials must be stated
as unknown rather than inferred.

## Part 2 — Adapt the CI drafts

Requirements the CI must satisfy regardless of deployment model:

- Tests gate deploys — nothing reaches production without build, typecheck and
  test suite passing.
- A human approves production, via a GitHub Environment named `production` with
  required reviewers, so merging to `main` is not the same act as shipping.
  Document the dashboard steps; do not perform them.
- PRs get a live preview URL, posted as a PR comment.
- The rollback target is recorded in the run log of every production deploy,
  before anything is overwritten.
- Post-deploy health check against the real domain: HTTP 200 and security
  headers still present.
- Keep the no-external-origins check — grep built output for `http(s)://` and
  fail on anything outside an allowlist. Run it against the current `dist/`
  first, tune the allowlist to what legitimately appears, and report what it
  flagged.

Adjust mechanics to the real model: Pages Direct Upload implies
`wrangler pages deploy` and branch-alias previews; a Worker with static assets
implies `wrangler versions upload` plus a separate `versions deploy`, with
version IDs, per-version preview URLs and gradual rollout.

Note whether the API token scope in `SETUP.md` is correct for the model found —
the draft assumes Account → Cloudflare Pages → Edit.

## Deliverables

- `DEPLOYMENT.md` — ground truth with evidence, current live deployment ID, and
  the rollback procedure.
- Corrected `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`.
- Corrected `SETUP.md` — exactly the manual steps David must perform: API token
  creation and scope, the two GitHub secrets, the production environment and
  reviewer, branch protection with required checks.
- PR description covering what was found, what changed from the drafts and why,
  and anything that could not be verified.

Do not enable anything. The PR should be safe to sit unmerged indefinitely.

## Conventions

- Work in a git worktree; keep this `PROMPT.md` in the worktree root.
- Bisect-clean commits.
- Dual validation: green CI and David's verification before merge.
- After pushing the branch and opening the PR, remove the worktree.
