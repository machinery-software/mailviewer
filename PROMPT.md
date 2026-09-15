# mailviewer.app — replace the deploy script with a gated release flow

Small, scripts-and-docs-only change. No application code, no test logic.

**Never deploy. Never self-merge.** Output is a PR.

Production is `a7ce8d93-1f6a-4398-a0a9-302127bcfdd4`. Rollback target if
anything goes wrong: `9b24838a-47b8-4516-84dd-92fc0f193eee`.

## Why

Two real problems with the current scripts, both hit in practice today:

1. **`test:print` serves `dist/` but never builds it.** Run it after a pull and
   it silently reports on the *previous* bundle. This happened: 30 of 81 tests
   failed with the pre-fix values (`#141417`, 1.58:1 contrast) against a merge
   that had already fixed them. The tests must guarantee their own input.

2. **`deploy` is `npm run build && wrangler deploy`** — a one-step, unreviewed
   push straight to the apex with no version upload, no preview, no test gate.
   It predates the versions workflow. It is also the word muscle memory reaches
   for.

## Change

Replace the `scripts` block in `package.json` with:

```json
"scripts": {
  "dev": "vite",
  "build": "tsc --noEmit && vite build",
  "preview": "vite preview",
  "test": "vitest run",
  "test:print": "npm run build && vitest run --config vitest.print.config.ts",
  "release:preview": "npm test && npm run test:print && wrangler versions upload --preview-alias staging",
  "release:promote": "wrangler versions deploy",
  "deploy": "echo '\\n  Use: npm run release:preview  ->  verify the preview URL  ->  npm run release:promote\\n  See DEPLOYMENT.md §8.\\n' && exit 1"
}
```

Intent, in case the exact form needs adjusting:

- `test:print` builds before running, so it can never test a stale bundle.
- `release:preview` runs unit tests, then print tests, then uploads a
  **zero-traffic** version. Any failure stops before anything reaches
  Cloudflare. No redundant second build — `test:print` already produced
  `dist/`.
- `release:promote` is a deliberate separate step. Promoting is never a side
  effect of building or testing.
- `deploy` refuses and prints the correct procedure rather than firing.
- A fixed `staging` alias keeps the preview URL constant instead of climbing
  `staging2`, `staging3`, `staging4`.

Verify the echo escaping actually renders on both `sh` and `zsh` — if the
`\\n` form is awkward in JSON, use whatever produces clean multi-line output,
as long as it exits non-zero.

## Also update DEPLOYMENT.md §8

The manual release procedure there currently spells out the raw wrangler
commands. Rewrite it around `release:preview` / `release:promote`, keeping:

- what to check on the preview before promoting (this is the human gate)
- the current production version ID and the rollback command
- the note that preview URLs are on `workers.dev`, **outside the zone**, so
  they cannot reveal zone-level problems such as the analytics beacon
  (MAC-515) — that check only works against the apex, with a browser UA

**Docs and scripts change in the same commit.** They drifting apart is exactly
why `SETUP.md` was deleted.

## Constraints

- No application code changes. No changes to test assertions.
- Do not add a CI job here — running the print suite in CI is MAC-596 and has
  its own ticket.
- Do not add Cloudflare credentials anywhere. Releases stay local and manual;
  the repo holds no deploy token.
- 267 unit tests and 81 print tests stay green.

## Verify before opening the PR

- `npm run deploy` exits non-zero and prints the guidance
- `npm run test:print` builds first — confirm by touching a source file and
  checking the new output is reflected without a manual `npm run build`
- `npm run release:preview` runs both suites and stops on failure. **Do not
  let it complete an upload** — stop it before the wrangler step, or confirm
  with David first. Uploading is harmless (zero traffic) but it is his call.

## Conventions

- Git worktree; keep this PROMPT.md in the worktree root.
- Bisect-clean commits.
- Remove the worktree after pushing.
