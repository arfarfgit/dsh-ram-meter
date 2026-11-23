/**
 * Pure presentation helpers.
 *
 * Everything here is deterministic and side-effect free so the Unit tests can pin the exact
 * strings the pill renders, and so both halves can share one definition of a sample.
 *
 * Wording matters here: the number is the process's resident set size (RSS) and the percentage is
 * that RSS measured against the V8 heap ceiling — not "RAM used" and not "heap used". Every string
 * below says so, and a sample above the ceiling is described as such instead of a bare 100%.
 */

export interface HeapSample {
  /** Resident set size in bytes, from `process.memoryUsage().rss`. */
  readonly rss: number
  /** V8 heap in use, in bytes. */
  readonly heapUsed: number
  /** V8 heap currently reserved, in bytes. */
  readonly heapTotal: number
  /** The process's V8 heap ceiling in bytes, from `v8.getHeapStatistics().heap_size_limit`. */
  readonly heapLimit: number
  /** Host process uptime in seconds. */
  readonly uptimeSec: number
  /** Host process id. */
  readonly pid: number
}

export const BYTES_PER_GIB = 1024 ** 3

/** Labels the Client localises; the defaults keep these helpers testable on their own. */
export interface MeterLabels {
  /** Short label of the measured value: the resident set. */
  readonly rss: string
  readonly heap: string
  /** Connective in `8.8% of the 16 GB V8 heap ceiling`. */
  readonly shareOf: string
  /** Name of the denominator, so the reader sees what the percentage is a share of. */
  readonly ceiling: string
  readonly pid: string
  readonly uptime: string
  readonly unavailable: string
  /** Product name used to open the accessible label. */
  readonly meter: string
  /** Connective for the above-ceiling sentence. */
  readonly isAbove: string
  /** Explains that the percentage is clamped. */
  readonly clamped: string
}

export const EN_LABELS: MeterLabels = {
  rss: 'RSS',
  heap: 'Heap',
  shareOf: 'of the',
  ceiling: 'V8 heap ceiling',
  pid: 'PID',
  uptime: 'uptime',
  unavailable: 'RAM meter unavailable',
  meter: 'RAM meter',
  isAbove: 'is above the',
  clamped: 'clamped to 100%',
}

/**
 * Format a byte count as gigabytes for the pill.
 * @param bytes - byte count; negative and non-finite values read as zero.
 * @returns e.g. `1.4 GB`, and two decimals below one gigabyte so small hosts stay readable.
 */
export function formatGigabytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) / BYTES_PER_GIB : 0
  return `${value < 1 ? value.toFixed(2) : value.toFixed(1)} GB`
}

/**
 * Format the heap ceiling the same way the pill's right-hand label shows it.
 * @param bytes - the process's heap_size_limit in bytes.
 * @returns whole gigabytes from ten up (`16 GB`), one decimal below that (`4.0 GB`).
 */
export function formatCeiling(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) / BYTES_PER_GIB : 0
  return value >= 10 ? `${Math.round(value)} GB` : `${value.toFixed(1)} GB`
}

/**
 * Share of the ceiling the resident set occupies, as a percentage.
 * @param rss - resident bytes.
 * @param heapLimit - the ceiling in bytes.
 * @returns a number clamped to 0..100, or 0 when either side is unusable.
 */
export function percentageOf(rss: number, heapLimit: number): number {
  if (!Number.isFinite(rss) || !Number.isFinite(heapLimit) || rss <= 0 || heapLimit <= 0) return 0
  return Math.min(100, Math.max(0, (rss / heapLimit) * 100))
}

/**
 * Whether the resident set has grown past the V8 heap ceiling.
 * A resident set can exceed the heap ceiling; the pill keeps the clamped percentage but must not
 * present that as an ordinary 100% reading.
 * @param sample - the latest host sample.
 * @returns true when `rss` is strictly greater than a usable `heapLimit`.
 */
export function isOverCeiling(sample: HeapSample): boolean {
  return Number.isFinite(sample.heapLimit) && sample.heapLimit > 0 && sample.rss > sample.heapLimit
}

/** Colour band of the pill: neutral below 50%, amber from 50% to 75%, red above 75%. */
export type MeterTone = 'neutral' | 'amber' | 'red'

/**
 * Pick the colour band for a percentage.
 * @param percentage - a value from {@link percentageOf}.
 * @param overCeiling - a sample above the ceiling is always red, whatever the clamped value says.
 * @returns `neutral` (<50), `amber` (50..75 inclusive), `red` (>75 or over the ceiling).
 */
export function toneFor(percentage: number, overCeiling = false): MeterTone {
  if (overCeiling) return 'red'
  if (!Number.isFinite(percentage) || percentage < 50) return 'neutral'
  if (percentage <= 75) return 'amber'
  return 'red'
}

/** Colours per band. Neutral inherits the host label colour through a CSS variable. */
export const TONE_COLORS: Record<MeterTone, string> = {
  neutral: 'var(--dsw-alias-label-primary, #e8edf5)',
  amber: '#d8a13a',
  red: '#e2685f',
}

/**
 * Format a percentage for the pill's compact label.
 * @param percentage - a value from {@link percentageOf}.
 * @returns e.g. `9%`; whole percent, clamped to 0..100.
 */
export function formatPercent(percentage: number): string {
  if (!Number.isFinite(percentage)) return '0%'
  return `${Math.round(Math.min(100, Math.max(0, percentage)))}%`
}

/**
 * Format uptime the way the tooltip shows it.
 * @param seconds - uptime in seconds.
 * @returns `2h 14m`, `14m 3s`, or `9s`.
 */
export function formatUptime(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

/**
 * One sentence describing the share of the ceiling, used by the pill summary and the tooltip.
 * @param sample - the latest host sample.
 * @param labels - localised labels; English by default.
 * @returns e.g. `RSS 1.4 GB · 8.8% of the 16 GB V8 heap ceiling`.
 */
export function describeShare(sample: HeapSample, labels: MeterLabels = EN_LABELS): string {
  const gigabytes = formatGigabytes(sample.rss)
  const ceiling = formatCeiling(sample.heapLimit)
  if (isOverCeiling(sample)) {
    return `${labels.rss} ${gigabytes} ${labels.isAbove} ${ceiling} ${labels.ceiling} (${labels.clamped})`
  }
  const percentage = percentageOf(sample.rss, sample.heapLimit)
  return `${labels.rss} ${gigabytes} · ${percentage.toFixed(1)}% ${labels.shareOf} ${ceiling} ${labels.ceiling}`
}

/**
 * Accessible label for the pill: the product name plus the same sentence the tooltip uses.
 * @param sample - the latest host sample.
 * @param labels - localised labels; English by default.
 * @returns e.g. `RAM meter: RSS 1.4 GB · 8.8% of the 16 GB V8 heap ceiling`.
 */
export function pillSummary(sample: HeapSample, labels: MeterLabels = EN_LABELS): string {
  return `${labels.meter}: ${describeShare(sample, labels)}`
}

/**
 * The native tooltip: the share of the ceiling, heap used/total, PID and uptime.
 * @param sample - the latest host sample.
 * @param labels - localised labels; English by default.
 * @returns three newline-separated lines; an above-ceiling sample says so instead of a bare 100%.
 */
export function buildTooltip(sample: HeapSample, labels: MeterLabels = EN_LABELS): string {
  return [
    describeShare(sample, labels),
    `${labels.heap} ${formatGigabytes(sample.heapUsed)} / ${formatGigabytes(sample.heapTotal)}`,
    `${labels.pid} ${sample.pid} · ${labels.uptime} ${formatUptime(sample.uptimeSec)}`,
  ].join('\n')
}

/**
 * Validate that an unknown JSON body is a complete host sample.
 * @param value - parsed response body.
 * @returns the sample, or `undefined` when a field is missing or not a finite number.
 */
export function asHeapSample(value: unknown): HeapSample | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const read = (key: keyof HeapSample): number | undefined => {
    const field = record[key]
    return typeof field === 'number' && Number.isFinite(field) ? field : undefined
  }
  const rss = read('rss')
  const heapUsed = read('heapUsed')
  const heapTotal = read('heapTotal')
  const heapLimit = read('heapLimit')
  const uptimeSec = read('uptimeSec')
  const pid = read('pid')
  if (rss === undefined || heapUsed === undefined || heapTotal === undefined) return undefined
  if (heapLimit === undefined || uptimeSec === undefined || pid === undefined) return undefined
  return { rss, heapUsed, heapTotal, heapLimit, uptimeSec, pid }
}

