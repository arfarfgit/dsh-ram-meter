/**
 * The plugin's configuration contract, shared by both halves.
 *
 * The Host row's `config` is validated by Cordis through the Standard Schema interface
 * (`plugin.Config['~standard'].validate`), so this module exports that object directly and
 * stays free of any package import: the Host half must resolve in a profile that installs
 * only this bundle. Validation is forgiving by design — a missing or malformed value falls
 * back to the documented default instead of failing activation, and the interval is clamped.
 */

/** Where the pill is mounted. Each value maps to one Client slot in `./client/slots.ts`. */
export const PLACEMENTS = ['sidebar-footer', 'composer-dock', 'floating'] as const

export type Placement = (typeof PLACEMENTS)[number]

export const DEFAULT_PLACEMENT: Placement = 'sidebar-footer'

/** Poll cadence default, minimum and maximum in milliseconds. */
export const DEFAULT_REFRESH_INTERVAL_MS = 2000
export const MIN_REFRESH_INTERVAL_MS = 500
export const MAX_REFRESH_INTERVAL_MS = 10_000

export interface MeterConfig {
  readonly refreshIntervalMs: number
  readonly placement: Placement
}

export function isPlacement(value: unknown): value is Placement {
  return typeof value === 'string' && (PLACEMENTS as readonly string[]).includes(value)
}

/**
 * Coerce a configured cadence into the supported range.
 * @param value - raw configuration value, of any type.
 * @returns an integer between {@link MIN_REFRESH_INTERVAL_MS} and {@link MAX_REFRESH_INTERVAL_MS},
 * or {@link DEFAULT_REFRESH_INTERVAL_MS} when the value is not a usable number.
 */
export function clampRefreshInterval(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_REFRESH_INTERVAL_MS
  return Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(numeric)))
}

/**
 * Resolve any raw row config into the effective configuration.
 * @param input - the row's `config` value, possibly `undefined` or malformed.
 * @returns the configuration both halves use.
 */
export function resolveMeterConfig(input: unknown): MeterConfig {
  const record = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
  return {
    refreshIntervalMs: clampRefreshInterval(record.refreshIntervalMs),
    placement: isPlacement(record.placement) ? record.placement : DEFAULT_PLACEMENT,
  }
}

/**
 * Cordis validates the row's `config` with this object at activation.
 *
 * Standard Schema shape only: no dependency, no async, and no rejection path. Unknown keys are
 * dropped so a stale profile patch cannot leak values into the pill.
 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-ram-meter',
    validate(input: unknown): { value: MeterConfig } {
      return { value: resolveMeterConfig(input) }
    },
  },
}
