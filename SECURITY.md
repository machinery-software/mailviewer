# Security

## Reporting a vulnerability

Please report security problems privately, by either of:

- **Email:** security@machinery.software
- **GitHub:** [Report a vulnerability](https://github.com/machinery-software/mailviewer/security/advisories/new)
  (private vulnerability reporting on this repository)

Please don't open a public issue for a security problem. Include what you
found, how to reproduce it (a sample message helps; strip anything personal
from it), and what you think an attacker could do with it. We will
acknowledge your report, keep you told what we find, and credit you in the
fix unless you'd rather we didn't.

What's in scope: anything that lets a message, or an attachment, do more than
be read: script running in the viewer, a request leaving the page (the site's
Content-Security-Policy is meant to make that impossible), a way to make the
viewer hang or crash on a message, or a dependency we ship with a known
vulnerability. The site is [mailviewer.app](https://mailviewer.app); it
serves only static files, so there is no server-side code to report on.

`https://mailviewer.app/.well-known/security.txt` gives the same contacts.

## Dependency advisories

Every PR, every push to `main` and a weekly run check `package-lock.json`
with OSV-Scanner and `npm audit` (`.github/workflows/security.yml`), and
`npm run release:preview` checks it with `npm audit --omit=dev` before it
uploads anything. `scripts/security-gate.mjs` decides, using
`security-gate.json`:

- **Shipped** packages are the lockfile's non-dev ones: everything the site's
  bundle can contain. The rest (Vite, Vitest, Wrangler and their trees) are
  **build-only**: they never reach a browser, and their advisories are
  warnings.
- A shipped advisory of **high or critical** severity fails the check.
- So does a **moderate** one in a package that reads the messages people open
  (`reachable`: DOMPurify, postal-mime, fflate). DOMPurify's sanitizer
  bypasses are usually rated moderate, and for a mail viewer they are the
  ones that matter.
- An advisory of unknown severity in a shipped package fails: the check fails
  closed, and so does a scanner that cannot run.

If a blocking advisory is in code this site cannot reach, it can be
allowlisted in `security-gate.json`: the advisory id (or its CVE), the
package, the reason it is unreachable, and an expiry date at most a year out,
after which it blocks again:

```json
"allowlist": [
  {
    "id": "GHSA-xxxx-xxxx-xxxx",
    "package": "dompurify",
    "reason": "Only reachable through ADD_TAGS, which this site never passes.",
    "expires": "2027-01-31"
  }
]
```

Upgrading is always preferred. `scripts/security-gate-fixtures/` holds
lockfiles pinned to known-vulnerable versions and what the scanners said
about them; `scripts/security-gate.test.ts` runs the gate on them without the
network.
