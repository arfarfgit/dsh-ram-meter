# Changelog

## 0.1.3

Security, protocol and state-machine fixes. `GET /dsh-ram` and `/dsh-ram/config` now require the same
browser credential as the `/api` transport, so a reverse proxy can no longer expose process numbers.

- **The routes are authenticated.** Both handlers call the host Connection service's `admit()` — the
  exact fence `/api` uses: Host/Origin trust, then the signed, authority-bound browser cookie or an API
  credential. Without one the answer is `401` with `{ "error": "unauthorized" }` and no memory numbers;
  a rejected Host/Origin is `403`. A loopback peer address is still checked first, now as defence in
  depth with a comment saying so, because a proxy makes every client look like `127.0.0.1`. The plugin
  declares `connection` alongside `webServer` in its `inject` list, so it never registers a route it
  cannot authenticate.
- **`HEAD` is accepted** on both routes: same `content-type`, `cache-control` and `content-length` as
  `GET`, no body. `POST`, `PUT` and `DELETE` remain `405`.
- **`ram_meter.png` ships in the package** and the README references it by absolute jsDelivr URL, since
  relative image paths do not resolve on npmjs.com.
- **Pause is reference counted by reason** (`hover`, `hidden`) instead of one boolean, fixing both bugs
  in one change. A pill that unmounts while hovered no longer leaves the store paused forever, and a
  hidden tab no longer polls: visibility changes hold and release the `hidden` reason, and releasing the
  last reason takes one prompt sample. The epoch guard still discards an in-flight read. The pill
  releases only the `hover` reason it owns, on pointerleave, on unmount and when a configuration change
  moves it to another seat.
- **No React ref is written during render.** The hover-frozen tooltip is held in state from
  pointerenter, so a render that never commits cannot advance the text a committed view later shows.
- **Accessibility and wording.** The pill is a `role="group"` with `aria-live="off"` and keeps its
  label, so a two-second meter no longer announces itself continuously. The label and tooltip say the
  value is RSS measured against the V8 heap ceiling, not "RAM used". A sample above the ceiling keeps
  the clamped percentage but is forced to red and described in the tooltip instead of a bare 100%.
- Tests: route policy (unauthenticated, forbidden, `HEAD`, `405`, real HTTP), pause reasons and
  visibility, unmount-while-hovered, and the above-ceiling rendering — 72 tests.

## 0.1.2

Adds a storefront icon to the package.

- `package.json` now declares `icon: ./assets/icon-180.png`, the same 180x180 raster tile used by
  the community catalogue entry, and ships it in `files`. Plugin listings that read the package
  icon no longer fall back to a generic avatar or an unrenderable SVG.
- No code, route or behaviour change.

## 0.1.1

Fixes the flickering native tooltip.

- Hovering the pill now pauses the poll: no refresh runs while the pointer rests on it, so the
  displayed value and the tooltip text stay put instead of being rebuilt every 2 s and dismissing the
  open tooltip. Leaving the pill resumes polling with an immediate read.
- A read that is already in flight when the pointer arrives is discarded rather than published, so a
  hover can neither change the number nor flip the pill to `—`.
- The tooltip string is frozen for the duration of a hover, so a stray re-render (for example a
  configuration refresh) re-applies the identical `title` instead of a new one.
- Failure behaviour, colour thresholds and the routes are unchanged.

## 0.1.0

First release.

- Host routes `GET /dsh-ram` and `GET /dsh-ram/config`: loopback-only, `no-store`, measured
  `heap_size_limit` rather than a hard-coded ceiling.
- Client pill: `RAM 1.4 GB · 9%` plus a thin bar, in `sidebar.footer.action` by default.
- Configuration: `refreshIntervalMs` (default 2000, clamped 500..10000) and `placement`
  (`sidebar-footer` | `composer-dock` | `floating`), validated with a Standard Schema `Config`.
- Native tooltip with heap used/total, PID, uptime and the measured ceiling.
- Colour bands: neutral below 50%, amber 50–75%, red above 75%.
- Failure state `—` with a silent retry on the next tick.
- No runtime dependencies; the package ships only built artifacts, the bundle patch, locale and icon.
