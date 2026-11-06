# Brief (6 November 2026): make Workers versions findable and verify promote

New ticket in the mailviewer web repo (~/Documents/Github/mailviewer): make Workers versions findable and verify promote.

Today a promote went out before PR #27 was merged, and nothing said so. Workers versions cannot be deleted, so the fix is labeling and a status check, in the release scripts, not in the dashboard.

1. Every `wrangler versions upload` / deploy the release scripts perform must pass `--tag <git short sha>` and `--message "<short sha> <first line of the commit subject>"`. Promote must refuse to run from a dirty tree or from any branch but main, and must print the sha it is shipping.
2. Add `npm run release:status`: reads the live production deployment (wrangler deployments list / status, JSON), prints its version id, tag and message, then the local `git rev-parse --short HEAD`, and ends with one line: MATCH, or BEHIND <sha> if the live tag differs from HEAD. Exit code non-zero on BEHIND. Also print staging's current version the same way.
3. Promote runs release:status at its end, and the apex check (scripts/check-apex.sh) after that.
4. DEPLOYMENT.md: a short section "Which version is live?" that is release:status plus how to read `wrangler versions list` now that rows carry the sha.
5. Tests for the tag/message formatting and the MATCH/BEHIND decision (feed it fixture JSON); show one failing on a deliberately wrong comparison before the fix.

Open a PR against main; do not merge or promote.
