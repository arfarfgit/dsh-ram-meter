# RAM meter

Live host memory and heap-ceiling meter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
shown as a compact pill in the Web UI.

The pill reads the **host process's own** memory every two seconds and measures its ceiling instead of
assuming one: a stock host reports its ~4 GB V8 limit, a host launched with
`--max-old-space-size=16384` reports ~16 GB, and the pill shows whichever number the running process
actually has.

![Six RAM meter states: against the stock host's 4.1 GB ceiling — 0.67 GB · 16%, 2.2 GB · 53% (amber), 3.3 GB · 80% (red); and against a 16 GB ceiling — 2.9 GB · 18%, 4.64 GB · 29%, 8.53 GB · 53% (amber)](https://cdn.jsdelivr.net/npm/@npmghost/dsh-ram-meter@0.1.3/ram_meter.png)

```
RSS 1.4 GB · 9%
[▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁]
```

Hovering shows the details:

```
RSS 1.4 GB · 8.8% of the 16 GB V8 heap ceiling
Heap 0.40 GB / 0.60 GB
PID 4242 · uptime 1h 2m
```

The number is the host process's **resident set size (RSS)**, and the percentage is that RSS measured
against the process's V8 heap ceiling — not "RAM used" and not heap usage; heap used/total appears on
its own tooltip line.

- **Hover pauses the meter**: while the pointer rests on the pill no refresh runs, so the number and
  the tooltip hold still while you read them. The next sample lands as soon as the pointer leaves.
- **A hidden tab does not poll**: pause is reference counted by reason, so hovering and a background
  tab each hold the poll stopped, and it resumes when the last reason is released.
- **Colours**: neutral below 50%, amber from 50% to 75%, red above 75%.
- **Above the ceiling**: RSS can exceed the V8 heap ceiling. The bar keeps its clamped 100%, the pill
  is forced to red, and the tooltip says the sample is above the ceiling instead of showing a bare 100%.
- **Failure**: when the route cannot be read the pill shows `—` and retries on the next tick. It never
  throws and never writes to the browser console.

## Install

```sh
dsh plugin --profile <name> add @npmghost/dsh-ram-meter
```

Or, from a packed tarball, inside the profile directory:

```sh
pnpm add ./npmghost-dsh-ram-meter-0.1.3.tgz
```

Then add the bundle to the profile's `dsh.profile.bundles` list — Plugin Manager's **Add plugin**
does both steps for you — and restart the host so the Client loads the new bundle generation.

Requirements: DeepSeek Harness `>=0.2.2-rc.2 <0.3.0` (the `engines.dsh` field). The package has no
runtime dependencies: the Host half imports only `node:v8`, and the Client half receives React from
the page's module table.

## Configuration

The plugin row in a profile's `cordis.patch.yml` accepts two keys:

```yaml
- id: ram-meter
  name: '@npmghost/dsh-ram-meter'
  config:
    refreshIntervalMs: 2000   # 500..10000, default 2000
    placement: sidebar-footer # sidebar-footer | composer-dock | floating
```

| Key | Default | Notes |
|---|---|---|
| `refreshIntervalMs` | `2000` | Clamped to `500..10000`; a malformed value falls back to the default. |
| `placement` | `sidebar-footer` | `sidebar-footer` → `sidebar.footer.action`, `composer-dock` → `conversation.composer.dock`, `floating` → `shell.overlay`. |

The values are validated by the plugin's `Config` (a Standard Schema object) when the row activates,
and the same resolution is clamped again in the Client, so a stale profile patch cannot produce a
hostile cadence. Changing the placement takes effect on the next configuration refresh (within 30 s)
without a reload.

## Host routes

| Route | Response |
|---|---|
| `GET`/`HEAD /dsh-ram` | `{ rss, heapUsed, heapTotal, heapLimit, uptimeSec, pid }` |
| `GET`/`HEAD /dsh-ram/config` | `{ refreshIntervalMs, placement }` |

Both routes sit behind the same fence as the harness's `/api` transport: the plugin calls the host
Connection service's `admit()` for every request, which applies the Host/Origin trust check and then
requires the signed, authority-bound browser session cookie (or an API credential). Without that
credential the answer is `401` and the body carries no numbers. A loopback peer address is checked
first as defence in depth only — it is not authentication, because a reverse proxy makes every client
look like `127.0.0.1`. The pill works because it is a same-origin `fetch`, so the page's cookie rides
along.

`HEAD` answers with the same headers as `GET` (including `content-length`) and no body. Any other
method is `405`, and both routes send `cache-control: no-store`, plus `403` for a non-loopback peer.

`heapLimit` is `v8.getHeapStatistics().heap_size_limit` of the host process — the same number the
pill divides by. `rss` is `process.memoryUsage().rss`.

## Development

```sh
npm install
npm run build      # tsdown → lib/index.js (Host) + lib/client.js (Client script)
npm run typecheck
npm test           # unit, route and polling-store tests (vitest)
npm run test:e2e   # headless Edge over CDP (see the note below)
```

The e2e harness mints the page credential itself — one `redirect: 'manual'` request to the token URL
the host prints, then the cookie it sets — and asserts the route protocol before it opens the page:
`401` without the credential and no `rss` in the body, `GET` 200 with the six fields, `HEAD` 200 with
the same `content-length` and an empty body, and `405` for `POST`. It then checks the live pill, the
changing value and the hover freeze.

`lib/index.js` is ESM and exports `apply`, `inject` and `Config`. `lib/client.js` is a plain script
with no module syntax: it registers a lazy factory in `window.__ModuleLoader__` whose id is the
package name, and its only module request is `react`.

## Limitations

- `composer-dock` maps to `conversation.composer.dock`, which DSH renders only inside an open
  conversation. The landing page has no conversation, so with that placement the pill appears once a
  session with a composer is open — it is not visible on the start screen. `sidebar-footer` and
  `floating` are visible everywhere.
- The pill has 11 px of text; long localized words are not wrapped.
- The `floating` placement sits above the frame's overlay layer, so another overlay plugin may
  render above it.
- The colour bands are exercised by unit tests; a host that never crosses 50% will not show amber or
  red in normal use.

## License

MIT © npmghost

