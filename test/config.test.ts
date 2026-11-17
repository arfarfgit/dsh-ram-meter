import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_PLACEMENT,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS,
  clampRefreshInterval,
  isPlacement,
  resolveMeterConfig,
} from '../src/config'

describe('interval clamping', () => {
  it('defaults to 2000 when nothing usable is configured', () => {
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(2000)
    expect(clampRefreshInterval(undefined)).toBe(2000)
    expect(clampRefreshInterval(null)).toBe(2000)
    expect(clampRefreshInterval('')).toBe(2000)
    expect(clampRefreshInterval('fast')).toBe(2000)
    expect(clampRefreshInterval(Number.NaN)).toBe(2000)
    expect(clampRefreshInterval(Infinity)).toBe(2000)
  })

  it('raises values below 500 to the minimum', () => {
    expect(MIN_REFRESH_INTERVAL_MS).toBe(500)
    expect(clampRefreshInterval(0)).toBe(500)
    expect(clampRefreshInterval(-2000)).toBe(500)
    expect(clampRefreshInterval(499)).toBe(500)
  })

  it('lowers values above 10000 to the maximum', () => {
    expect(MAX_REFRESH_INTERVAL_MS).toBe(10_000)
    expect(clampRefreshInterval(10_001)).toBe(10_000)
    expect(clampRefreshInterval(1e9)).toBe(10_000)
  })

  it('keeps values inside the range and rounds fractions', () => {
    expect(clampRefreshInterval(2000)).toBe(2000)
    expect(clampRefreshInterval(500)).toBe(500)
    expect(clampRefreshInterval(10_000)).toBe(10_000)
    expect(clampRefreshInterval(1234.6)).toBe(1235)
    expect(clampRefreshInterval('3000')).toBe(3000)
  })
})

describe('placement', () => {
  it('accepts exactly the three documented values', () => {
    expect(isPlacement('sidebar-footer')).toBe(true)
    expect(isPlacement('composer-dock')).toBe(true)
    expect(isPlacement('floating')).toBe(true)
    expect(isPlacement('top-right')).toBe(false)
    expect(isPlacement(undefined)).toBe(false)
  })

  it('defaults to the sidebar footer', () => {
    expect(DEFAULT_PLACEMENT).toBe('sidebar-footer')
    expect(resolveMeterConfig({}).placement).toBe('sidebar-footer')
    expect(resolveMeterConfig({ placement: 'nowhere' }).placement).toBe('sidebar-footer')
  })
})

describe('resolved configuration', () => {
  it('resolves an empty or malformed config to the documented defaults', () => {
    expect(resolveMeterConfig(undefined)).toEqual({ refreshIntervalMs: 2000, placement: 'sidebar-footer' })
    expect(resolveMeterConfig(null)).toEqual({ refreshIntervalMs: 2000, placement: 'sidebar-footer' })
    expect(resolveMeterConfig('sidebar-footer')).toEqual({ refreshIntervalMs: 2000, placement: 'sidebar-footer' })
  })

  it('keeps valid values and drops unknown keys', () => {
    expect(resolveMeterConfig({ refreshIntervalMs: 5000, placement: 'floating', extra: true }))
      .toEqual({ refreshIntervalMs: 5000, placement: 'floating' })
  })
})

describe('Config schema', () => {
  it('is a Standard Schema that always resolves', () => {
    const schema = Config['~standard']
    expect(schema.version).toBe(1)
    const result = schema.validate({ refreshIntervalMs: 10, placement: 'floating' })
    expect(result).toEqual({ value: { refreshIntervalMs: 500, placement: 'floating' } })
  })

  it('resolves an absent config to defaults instead of reporting issues', () => {
    expect(Config['~standard'].validate(undefined)).toEqual({
      value: { refreshIntervalMs: 2000, placement: 'sidebar-footer' },
    })
  })
})
