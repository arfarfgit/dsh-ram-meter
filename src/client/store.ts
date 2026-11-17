/**
 * The Client's data source: one polling store shared by every slot occurrence.
 *
 * Rules that matter for the pill's behaviour:
 * - a failed read clears the sample so the pill shows "—", and the next tick retries;
 * - nothing here throws or logs to the console: a host route that is missing, restarting, or
 *   answering garbage must degrade to the em dash, not to an error boundary or a console flood.
 */
import {
  DEFAULT_PLACEMENT,
  DEFAULT_REFRESH_INTERVAL_MS,
  resolveMeterConfig,
  type MeterConfig,
} from '../config'
import { asHeapSample, type HeapSample } from '../format'

export interface MeterState {
  /** Latest successful sample, or `null` when the last read failed. */
  readonly sample: HeapSample | null
  /** True when the last read did not produce a sample. */
  readonly unreachable: boolean
  /** Effective configuration, refreshed from the host. */
  readonly config: MeterConfig
}

export interface MeterStore {
  getSnapshot(): MeterState
  subscribe(listener: () => void): () => void
  /** Start polling; idempotent. */
  start(): void
  /** Stop polling and abort any in-flight read; idempotent. */
  stop(): void
  /**
   * Suspend refreshes. The pill calls this while the pointer rests on it, so the rendered text (and
   * with it the native tooltip) stops changing under the cursor; idempotent.
   */
  pause(): void
  /** Resume after {@link pause}: reads once immediately, then follows the configured cadence. */
  resume(): void
}

export interface MeterStoreOptions {
  /** Route prefix; empty means same-origin, which is how the Client reaches the host. */
  readonly baseUrl?: string
  /** Transport override for tests. */
  readonly fetcher?: typeof fetch
  /** How often the configuration route is re-read, in milliseconds. */
  readonly configRefreshMs?: number
}

const STATS_PATH = '/dsh-ram'
const CONFIG_PATH = '/dsh-ram/config'
const DEFAULT_CONFIG_REFRESH_MS = 30_000

function sameConfig(a: MeterConfig, b: MeterConfig): boolean {
  return a.refreshIntervalMs === b.refreshIntervalMs && a.placement === b.placement
}

/**
 * Create the polling store for one Client plugin instance.
 * @param options - transport and cadence overrides, used by tests.
 * @returns a store that components subscribe to through `useSyncExternalStore`.
 */
export function createMeterStore(options: MeterStoreOptions = {}): MeterStore {
  const fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const configRefreshMs = options.configRefreshMs ?? DEFAULT_CONFIG_REFRESH_MS
  const base = options.baseUrl ?? ''

  const listeners = new Set<() => void>()
  let state: MeterState = {
    sample: null,
    unreachable: false,
    config: { refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS, placement: DEFAULT_PLACEMENT },
  }
  let running = false
  let paused = false
  /**
   * Bumped whenever work is abandoned (pause, stop). A read that started under an older epoch is
   * discarded instead of publishing: an aborted fetch must not flip the pill to "—" mid-hover.
   */
  let epoch = 0
  let statsTimer: ReturnType<typeof setTimeout> | undefined
  let configTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  function clearTimers(): void {
    if (statsTimer !== undefined) clearTimeout(statsTimer)
    if (configTimer !== undefined) clearTimeout(configTimer)
    statsTimer = undefined
    configTimer = undefined
  }

  function isCurrent(startedAt: number): boolean {
    return running && !paused && startedAt === epoch
  }

  function publish(next: MeterState): void {
    const previous = state
    if (previous.sample === next.sample && previous.unreachable === next.unreachable
      && sameConfig(previous.config, next.config)) return
    state = next
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        // A broken subscriber must not stop the poll or the other subscribers.
      }
    }
  }

  async function readJson(path: string): Promise<unknown> {
    if (controller === undefined) controller = new AbortController()
    const response = await fetcher(`${base}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }

  function scheduleStats(delayMs = state.config.refreshIntervalMs): void {
    if (!running || paused || statsTimer !== undefined) return
    statsTimer = setTimeout(async () => {
      statsTimer = undefined
      const startedAt = epoch
      try {
        const sample = asHeapSample(await readJson(STATS_PATH))
        if (sample === undefined) throw new Error('malformed sample')
        if (!isCurrent(startedAt)) return
        publish({ ...state, sample, unreachable: false })
      } catch {
        if (!isCurrent(startedAt)) return
        publish({ ...state, sample: null, unreachable: true })
      }
      scheduleStats()
    }, delayMs)
  }

  async function refreshConfig(): Promise<void> {
    const startedAt = epoch
    try {
      const resolved = resolveMeterConfig(await readJson(CONFIG_PATH))
      if (!isCurrent(startedAt)) return
      if (!sameConfig(state.config, resolved)) {
        const previousInterval = state.config.refreshIntervalMs
        publish({ ...state, config: resolved })
        if (previousInterval !== resolved.refreshIntervalMs && statsTimer !== undefined) {
          clearTimeout(statsTimer)
          statsTimer = undefined
          scheduleStats()
        }
      }
    } catch {
      // The configuration route is optional: defaults keep the pill working.
    }
  }

  function scheduleConfig(): void {
    if (!running || paused || configTimer !== undefined) return
    configTimer = setTimeout(() => {
      configTimer = undefined
      void refreshConfig().then(() => scheduleConfig())
    }, configRefreshMs)
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (running) return
      running = true
      void refreshConfig()
      scheduleStats()
      scheduleConfig()
    },
    stop() {
      running = false
      paused = false
      epoch += 1
      clearTimers()
      controller?.abort()
      controller = undefined
    },
    pause() {
      if (!running || paused) return
      paused = true
      epoch += 1
      clearTimers()
      controller?.abort()
      controller = undefined
    },
    resume() {
      if (!running || !paused) return
      paused = false
      // Read straight away so the value is fresh the moment the pointer leaves, then keep cadence.
      scheduleStats(0)
      scheduleConfig()
    },
  }
}
