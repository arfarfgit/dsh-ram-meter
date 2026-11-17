/**
 * Pure presentation helpers.
 *
 * Everything here is deterministic and side-effect free so the Unit tests can pin the exact
 * strings the pill renders, and so both halves can share one definition of a sample.
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
  readonly ram: string
  readonly heap: string
  readonly of: string
  readonly ceiling: string
  readonly pid: string
  readonly uptime: string
  readonly unavailable: string
}

export const EN_LABELS: MeterLabels = {
  ram: 'RAM',
  heap: 'Heap',
  of: 'of',
  ceiling: 'ceiling',
  pid: 'PID',
  uptime: 'uptime',
  unavailable: 'RAM meter unavailable',
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

/** Colour band of the pill: neutral below 50%, amber from 50% to 75%, red above 75%. */
export type MeterTone = 'neutral' | 'amber' | 'red'

/**
 * Pick the colour band for a percentage.
 * @param percentage - a value from {@link percentageOf}.
 * @returns `neutral` (<50), `amber` (50..75 inclusive), `red` (>75).
 */
export function toneFor(percentage: number): MeterTone {
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
 * One-line summary used for the pill's accessible label and by the End-to-end test.
 * @param sample - the latest host sample.
 * @param labels - localised labels; English by default.
 * @returns e.g. `RAM 1.4 GB · 9%`.
 */
export function pillSummary(sample: HeapSample, labels: MeterLabels = EN_LABELS): string {
  const percentage = percentageOf(sample.rss, sample.heapLimit)
  return `${labels.ram} ${formatGigabytes(sample.rss)} · ${formatPercent(percentage)}`
}

/**
 * The native tooltip: heap used/total, PID, uptime, and the measured ceiling.
 * @param sample - the latest host sample.
 * @param labels - localised labels; English by default.
 * @returns three newline-separated lines.
 */
export function buildTooltip(sample: HeapSample, labels: MeterLabels = EN_LABELS): string {
  const percentage = percentageOf(sample.rss, sample.heapLimit)
  return [
    `${labels.ram} ${formatGigabytes(sample.rss)} ${labels.of} ${formatCeiling(sample.heapLimit)} ${labels.ceiling} (${percentage.toFixed(1)}%)`,
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
