import { describe, expect, it } from 'vitest'
import {
  EN_LABELS,
  asHeapSample,
  buildTooltip,
  formatCeiling,
  formatGigabytes,
  formatPercent,
  formatUptime,
  percentageOf,
  pillSummary,
  toneFor,
  type HeapSample,
} from '../src/format'

const GIB = 1024 ** 3

function sample(overrides: Partial<HeapSample> = {}): HeapSample {
  return {
    rss: 1.4 * GIB,
    heapUsed: 0.4 * GIB,
    heapTotal: 0.6 * GIB,
    heapLimit: 16 * GIB,
    uptimeSec: 3725,
    pid: 4242,
    ...overrides,
  }
}

describe('byte formatting', () => {
  it('uses two decimals below one gigabyte and one decimal above', () => {
    expect(formatGigabytes(0.22 * GIB)).toBe('0.22 GB')
    expect(formatGigabytes(0.999 * GIB)).toBe('1.00 GB')
    expect(formatGigabytes(1.4 * GIB)).toBe('1.4 GB')
    expect(formatGigabytes(16.19 * GIB)).toBe('16.2 GB')
  })

  it('treats missing or nonsensical byte counts as zero', () => {
    expect(formatGigabytes(0)).toBe('0.00 GB')
    expect(formatGigabytes(-5)).toBe('0.00 GB')
    expect(formatGigabytes(Number.NaN)).toBe('0.00 GB')
  })

  it('shows the measured ceiling as whole gigabytes from ten up', () => {
    expect(formatCeiling(16.19 * GIB)).toBe('16 GB')
    expect(formatCeiling(4 * GIB)).toBe('4.0 GB')
    expect(formatCeiling(3.5 * GIB)).toBe('3.5 GB')
  })
})

describe('percentage', () => {
  it('divides the resident set by the measured ceiling', () => {
    expect(percentageOf(1.4 * GIB, 16 * GIB)).toBeCloseTo(8.75, 6)
    expect(percentageOf(4 * GIB, 16 * GIB)).toBe(25)
  })

  it('clamps and survives unusable inputs', () => {
    expect(percentageOf(0, 16 * GIB)).toBe(0)
    expect(percentageOf(32 * GIB, 16 * GIB)).toBe(100)
    expect(percentageOf(-1, 16 * GIB)).toBe(0)
    expect(percentageOf(1, 0)).toBe(0)
    expect(percentageOf(Number.NaN, 16 * GIB)).toBe(0)
  })

  it('formats the compact pill label', () => {
    expect(formatPercent(8.75)).toBe('9%')
    expect(formatPercent(50)).toBe('50%')
    expect(formatPercent(100.4)).toBe('100%')
    expect(formatPercent(Number.NaN)).toBe('0%')
  })
})

describe('colour threshold', () => {
  it('is neutral below 50', () => {
    expect(toneFor(0)).toBe('neutral')
    expect(toneFor(49.99)).toBe('neutral')
  })

  it('is amber from 50 through 75 inclusive', () => {
    expect(toneFor(50)).toBe('amber')
    expect(toneFor(62.5)).toBe('amber')
    expect(toneFor(75)).toBe('amber')
  })

  it('is red above 75', () => {
    expect(toneFor(75.01)).toBe('red')
    expect(toneFor(100)).toBe('red')
  })

  it('falls back to neutral for a non-finite value', () => {
    expect(toneFor(Number.NaN)).toBe('neutral')
  })
})

describe('uptime', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatUptime(9)).toBe('9s')
    expect(formatUptime(63)).toBe('1m 3s')
    expect(formatUptime(3725)).toBe('1h 2m')
    expect(formatUptime(0)).toBe('0s')
    expect(formatUptime(Number.NaN)).toBe('0s')
  })
})

describe('text built from a sample', () => {
  it('summarises the pill in one line', () => {
    expect(pillSummary(sample())).toBe('RAM 1.4 GB · 9%')
  })

  it('lists heap used/total, pid, uptime and the measured ceiling in the tooltip', () => {
    const tooltip = buildTooltip(sample())
    const lines = tooltip.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('RAM 1.4 GB of 16 GB ceiling (8.8%)')
    expect(lines[1]).toBe('Heap 0.40 GB / 0.60 GB')
    expect(lines[2]).toBe('PID 4242 · uptime 1h 2m')
  })

  it('uses the localised labels it is given', () => {
    const labels = { ...EN_LABELS, ram: 'Memory', pid: 'Prozess-ID', uptime: 'Laufzeit' }
    expect(pillSummary(sample(), labels)).toContain('Memory 1.4 GB')
    expect(buildTooltip(sample(), labels)).toContain('Prozess-ID 4242 · Laufzeit 1h 2m')
  })
})

describe('response validation', () => {
  it('accepts a complete six-field sample', () => {
    expect(asHeapSample(sample())).toEqual(sample())
  })

  it('rejects bodies with a missing or non-numeric field', () => {
    expect(asHeapSample(null)).toBeUndefined()
    expect(asHeapSample({ rss: 1 })).toBeUndefined()
    const { pid: _pid, ...withoutPid } = sample()
    expect(asHeapSample(withoutPid)).toBeUndefined()
    expect(asHeapSample({ ...sample(), heapLimit: 'sixteen' })).toBeUndefined()
  })
})
