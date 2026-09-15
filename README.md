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
npm run release:promote -- <version-id>@100 --yes  # only after checking that version's preview
```

Nothing reaches Cloudflare unless the unit and print suites pass, and nothing
reaches users until a person has looked at the preview. `npm run deploy`
deliberately refuses. There is no deploy workflow, and the repository holds no
Cloudflare credentials. The full procedure — what to check on the preview, and
how to roll back — is [DEPLOYMENT.md §8](DEPLOYMENT.md#8-releasing).

## Layout

```
public/_headers            The privacy guarantee. Read this first.
src/lib/model.ts           The one message shape every parser targets.
src/lib/sanitize.ts        HTML sanitisation + tracking-pixel neutralisation.
src/lib/netguard.ts        Live self-monitoring of our own network activity.
src/lib/parse/
  detect.ts                Format sniffing by magic bytes, not extension.
  eml.ts  mbox.ts          RFC822 and mbox archives.
  cfb.ts  msg.ts  lzfu.ts  Outlook .msg, from scratch.
  pst/                     Outlook .pst/.ost, from scratch (MS-PST).
src/worker/parse.worker.ts Parsing runs off the main thread.
```

## Limits

- Message bodies render in a sandboxed, script-free iframe. Remote images are
  stripped and counted rather than loaded — that's what kills tracking pixels,
  but it also means some marketing mail will look bare.
- `.pst` support is a from-scratch implementation of a large Microsoft
  specification. It handles the common Unicode PST layout; exotic or corrupt
  files may parse partially, and the viewer will say so rather than pretend.
- Everything is held in memory, so a very large `.pst` is bounded by your tab's
  available RAM.

## Licence

MIT.
