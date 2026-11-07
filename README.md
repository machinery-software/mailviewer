# Mailviewer

Read `.eml`, `.emlx`, `.msg`, `.mbox`, `.pst` and `.ost` files in a browser tab.
Nothing is uploaded. Nothing *can* be uploaded.

## The guarantee

Every page is served with this header:

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  img-src 'self' data: blob:; connect-src 'none'; form-action 'none';
  object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

`connect-src 'none'` tells the browser to refuse `fetch`, `XMLHttpRequest`,
WebSocket, `EventSource` and `sendBeacon` — every way a web page can send data to
a server. `form-action 'none'` closes the remaining route. The rules are enforced
by the user's browser, not by this code, which means they hold **even if this app
is buggy or malicious**.

The app is a folder of static files. There is no backend, no API route, no
analytics, no error reporter, no font CDN. `wrangler.jsonc` deliberately has no
`main` field, so Cloudflare serves the assets with no Worker script in front of
them — there is no server-side code that *could* see your mail, even in principle.

The site walks users through verifying all of this in Chrome DevTools at
[`/#/verify`](https://mailviewer.pages.dev/#/verify), including a button that
attempts a real exfiltration and shows the browser blocking it.

## Why so few dependencies

Three runtime dependencies: `react`, `react-dom`, `postal-mime` (RFC822 parsing)
and `dompurify` (HTML sanitisation). The CFB/`.msg` reader and the entire PST
reader are written from scratch in this repo rather than pulled from npm.

That is a deliberate trade. For a tool whose whole proposition is "your private
mail is safe here", every dependency is audit surface a user would have to
trust. A short, boring dependency list is a feature of the product, not just of
the build.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
npm test         # parser unit tests
```

The dev server sends a CSP that mirrors production (minus the websocket Vite
needs for hot reload), so a change that would break the privacy guarantee in
production breaks locally first.

## Deploying to Cloudflare (free)

Static assets on Workers are free, with no Worker invocations billed because
there is no Worker.

Releases are made by hand, in two gated steps:

```bash
npx wrangler login
npm run release:preview                            # tests, build, print tests, then upload a version serving no traffic
npm run release:promote -- <version-id>@100 --yes  # only after checking that version's preview; main, clean tree
npm run release:status                             # what is live, what is on staging, and MATCH or BEHIND <sha>
```

Every uploaded version is tagged with its commit's short sha and messaged
`<sha> <commit subject>`, so `wrangler versions list` says what each one is.
Promote runs from `main` with a clean tree only, prints the sha it ships, and
refuses a version whose tag is not `main`'s HEAD unless told it is a rollback.

Nothing reaches Cloudflare unless the unit and print suites pass, and nothing
reaches users until a person has looked at the preview. `npm run deploy`
deliberately refuses. There is no deploy workflow, and the repository holds no
Cloudflare credentials. The full procedure — what to check on the preview, and
how to roll back — is [DEPLOYMENT.md §8](DEPLOYMENT.md#8-releasing).

### After a promote: check the apex as a browser

```bash
scripts/check-apex.sh                 # https://mailviewer.app, the default
scripts/check-apex.sh https://staging-mailviewer.patchable-account.workers.dev
```

It fetches `/` and `/mac/` with Safari's User-Agent string and exits non-zero
if either body contains `cloudflareinsights` or `beacon.min.js`, or if either
response's `Cache-Control` lacks `no-transform`. The browser User-Agent is the
point: the Cloudflare zone has twice appended its Web Analytics beacon to the
HTML it serves to browsers, with no deploy on our side, and it does not do so
for `curl`'s own User-Agent, so a plain `curl` always looks clean. A preview on
`workers.dev` is outside the zone and cannot show it either; only the apex can,
and only after the promote. `public/_headers` marks every response
`no-transform`, which tells the proxy it may not rewrite the body; this script
confirms it held. [DEPLOYMENT.md §5a](DEPLOYMENT.md#5a-the-zone-injects-a-cloudflare-web-analytics-beacon)
has the history.

## Layout

```
public/_headers            The privacy guarantee. Read this first.
scripts/check-apex.sh      Asks the live site, as a browser, whether the edge rewrote it.
scripts/release.mjs        preview / promote / status: tagged versions, and MATCH or BEHIND.
src/lib/model.ts           The one message shape every parser targets.
src/lib/sanitize.ts        HTML sanitisation + tracking-pixel neutralisation.
src/lib/netguard.ts        Live self-monitoring of our own network activity.
src/lib/parse/
  detect.ts                Format sniffing by magic bytes, not extension.
  eml.ts  mbox.ts          RFC822 and mbox archives.
  cfb.ts  msg.ts  lzfu.ts  Outlook .msg, from scratch.
  pst/                     Outlook .pst/.ost, from scratch (MS-PST).
  olm.ts                   Outlook for Mac .olm archives.
  zip.ts  xml.ts           A streaming ZIP reader and a DOM-free XML reader
                           for .olm: plain ECMAScript, because the parse
                           worker has no DOMParser (MAC-513).
src/worker/parse.worker.ts Parsing runs off the main thread.
```

## Limits

- Message bodies render in a sandboxed, script-free iframe. Remote images are
  stripped and counted rather than loaded — that's what kills tracking pixels,
  but it also means some marketing mail will look bare.
- `.pst` support is a from-scratch implementation of a large Microsoft
  specification. It handles the common Unicode PST layout; exotic or corrupt
  files may parse partially, and the viewer will say so rather than pretend.
- `.pst` and `.ost` are not opened end to end by any automated test: the repo
  has no PST writer and no PST fixture (MAC-526). The browser suite only shows
  that the parse worker reaches the PST reader.
- `.olm` is tested against generated archives laid out the way Outlook for Mac
  is described as writing them, not against a real export (MAC-513, MAC-526).
  The archive's index is read first and each message on its own, so a large
  `.olm` is never unzipped whole. Times in an `.olm` carry no time zone and are
  shown as local time; whether Outlook writes them as UTC is unverified.
- Everything is held in memory, so a very large `.pst` is bounded by your tab's
  available RAM.
- A message is read up to its 1,000th MIME part. Nothing a mail client sends
  comes near that. A message with more is shown up to that point, and the bar
  above the viewer says which message it is, that it exceeds the limit, and
  how many parts are not shown. The original file is untouched.

## Licence

MIT — see [`LICENSE`](LICENSE).
