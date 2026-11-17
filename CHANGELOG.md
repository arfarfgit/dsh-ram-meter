# Changelog

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
