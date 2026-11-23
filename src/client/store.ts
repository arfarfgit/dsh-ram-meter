/**
 * The Client's data source: one polling store shared by every slot occurrence.
 *
 * Rules that matter for the pill's behaviour:
 * - a failed read clears the sample so the pill shows "—", and the next tick retries;
 * - nothing here throws or logs to the console: a host route that is missing, restarting, or
 *   answering garbage must degrade to the em dash, not to an error boundary or a console flood;
 * - pausing is reference counted by reason. The pill holds "hover" while the pointer rests on it and
 *   the store holds "hidden" while the page is hidden, so either one can release without reviving a
 *   poll the other still wants stopped. A boolean could not do that: a pill that unmounts while
 *   hovered never fires pointerleave, and one leaked "paused" would silence the meter forever.
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

/** Why polling is suspended. Each holder owns exactly the reasons it took. */
export type PauseReason = 'hover' | 'hidden'

export interface MeterStore {
  getSnapshot(): MeterState
  subscribe(listener: () => void): () => void
  /** Start polling; idempotent. */
  start(): void
  /** Stop polling, abort any in-flight read and drop the visibility listener; idempotent. */
  stop(): void
  /**
   * Suspend refreshes for one reason. Polling stays suspended while any reason is held; a reason
   * already held is a no-op so a duplicate event cannot unbalance the count.
   */
  pause(reason: PauseReason): void
  /**
   * Release one reason. When the last reason is released, polling resumes with an immediate read,
   * then follows the configured cadence; releasing a reason that is not held is a no-op.
   */
  resume(reason: PauseReason): void
}

/** Source of page visibility, injectable so the store is testable outside a browser. */
export interface VisibilitySource {
  /** Whether the page is hidden right now. */
  readonly hidden: boolean
  /** Listen for changes; returns the unsubscribe function. */
  subscribe(listener: (hidden: boolean) => void): () => void
}

export interface MeterStoreOptions {
  /** Route prefix; empty means same-origin, which is how the Client reaches the host. */
  readonly baseUrl?: string
  /** Transport override for tests. */
  readonly fetcher?: typeof fetch
  /** How often the configuration route is re-read, in milliseconds. */
  readonly configRefreshMs?: number
  /** Page visibility source; defaults to `document.visibilityState` when a document exists. */
  readonly visibility?: VisibilitySource
}

const STATS_PATH = '/dsh-ram'
const CONFIG_PATH = '/dsh-ram/config'
const DEFAULT_CONFIG_REFRESH_MS = 30_000

function sameConfig(a: MeterConfig, b: MeterConfig): boolean {
  return a.refreshIntervalMs === b.refreshIntervalMs && a.placement === b.placement
}

/** `document.visibilityState`, or a source that is always visible outside a browser. */
function documentVisibility(): VisibilitySource {
  return {
    get hidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden'
    },
    subscribe(listener) {
      if (typeof document === 'undefined') return () => {}
      const onChange = (): void => {
        listener(document.visibilityState === 'hidden')
      }
      document.addEventListener('visibilitychange', onChange)
      return () => {
        document.removeEventListener('visibilitychange', onChange)
      }
    },
  }
}

/**
 * Create the polling store for one Client plugin instance.
 * @param options - transport, cadence and visibility overrides, used by tests.
 * @returns a store that components subscribe to through `useSyncExternalStore`.
 */
export function createMeterStore(options: MeterStoreOptions = {}): MeterStore {
  const fetcher = options.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const configRefreshMs = options.configRefreshMs ?? DEFAULT_CONFIG_REFRESH_MS
  const visibility = options.visibility ?? documentVisibility()
  const base = options.baseUrl ?? ''

  const listeners = new Set<() => void>()
  const pauseReasons = new Set<PauseReason>()
  let disposeVisibility: (() => void) | undefined
  let state: MeterState = {
    sample: null,
    unreachable: false,
    config: { refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS, placement: DEFAULT_PLACEMENT },
  }
  let running = false
  /**
   * Bumped whenever work is abandoned (a first pause, stop). A read that started under an older
   * epoch is discarded instead of publishing: an aborted fetch must not flip the pill to "—".
   */
  let epoch = 0
  let statsTimer: ReturnType<typeof setTimeout> | undefined
  let configTimer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  function isPaused(): boolean {
    return pauseReasons.size > 0
  }

  function clearTimers(): void {
    if (statsTimer !== undefined) clearTimeout(statsTimer)
    if (configTimer !== undefined) clearTimeout(configTimer)
    statsTimer = undefined
    configTimer = undefined
  }

  function isCurrent(startedAt: number): boolean {
    return running && pauseReasons.size === 0 && startedAt === epoch
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
    if (!running || isPaused() || statsTimer !== undefined) return
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
    if (!running || isPaused() || configTimer !== undefined) return
    configTimer = setTimeout(() => {
      configTimer = undefined
      void refreshConfig().then(() => scheduleConfig())
    }, configRefreshMs)
  }

  function pause(reason: PauseReason): void {
    if (!running || pauseReasons.has(reason)) return
    const alreadyPaused = isPaused()
    pauseReasons.add(reason)
    if (alreadyPaused) return
    // First reason: abandon scheduled and in-flight work so nothing lands mid-read.
    epoch += 1
    clearTimers()
    controller?.abort()
    controller = undefined
  }

  function resume(reason: PauseReason): void {
    if (!running || !pauseReasons.has(reason)) return
    pauseReasons.delete(reason)
    if (isPaused()) return
    // Last reason released: read straight away so the value is fresh, then keep the cadence.
    scheduleStats(0)
    scheduleConfig()
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
      disposeVisibility = visibility.subscribe((hidden) => {
        if (hidden) pause('hidden')
        else resume('hidden')
      })
      if (visibility.hidden) {
        // Open in a background tab: hold the reason without arming any timer.
        pauseReasons.add('hidden')
        return
      }
      void refreshConfig()
      scheduleStats()
      scheduleConfig()
    },
    stop() {
      running = false
      pauseReasons.clear()
      epoch += 1
      clearTimers()
      disposeVisibility?.()
      disposeVisibility = undefined
      controller?.abort()
      controller = undefined
    },
    pause,
    resume,
  }
}
