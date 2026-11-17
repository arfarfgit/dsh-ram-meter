# Changelog

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
