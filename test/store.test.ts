import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMeterStore } from '../src/client/store'
import type { HeapSample } from '../src/format'

const GIB = 1024 ** 3

const LIVE: HeapSample = {
  rss: 1.4 * GIB,
  heapUsed: 0.4 * GIB,
  heapTotal: 0.6 * GIB,
  heapLimit: 16 * GIB,
  uptimeSec: 120,
  pid: 4242,
}

interface FakeResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

function ok(body: unknown): FakeResponse {
  return { ok: true, status: 200, json: async () => body }
}

function fail(status: number): FakeResponse {
  return { ok: false, status, json: async () => ({}) }
}

/** A jest-style mock with the transport signature the store expects. */
interface FakeFetcher {
  (input: RequestInfo | URL, init?: RequestInit): Promise<FakeResponse>
  mock: { calls: unknown[][] }
}

/** Build a fetcher whose per-path answers are supplied by the test. */
function fetcherFor(answers: { stats?: () => FakeResponse | Promise<FakeResponse>; config?: () => FakeResponse | Promise<FakeResponse> }): FakeFetcher {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/dsh-ram/config')) {
      return (answers.config ?? (() => fail(404)))()
    }
    return (answers.stats ?? (() => fail(503)))()
  }) as unknown as FakeFetcher
}

/** Store under test, with the cast kept in one place. */
function storeWith(fetcher: FakeFetcher) {
  return createMeterStore({ fetcher: fetcher as unknown as typeof fetch })
}

/** How many times the stats route was read. */
function statsReads(fetcher: FakeFetcher): number {
  return fetcher.mock.calls.filter(call => String(call[0]) === '/dsh-ram').length
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('polling store', () => {
  it('publishes the first sample and keeps polling at the configured cadence', async () => {
    const fetcher = fetcherFor({
      stats: () => ok(LIVE),
      config: () => ok({ refreshIntervalMs: 2000, placement: 'sidebar-footer' }),
    })
    const store = storeWith(fetcher)
    const seen: (HeapSample | null)[] = []
    store.subscribe(() => seen.push(store.getSnapshot().sample))

    store.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(store.getSnapshot().sample).toEqual(LIVE)
    expect(store.getSnapshot().unreachable).toBe(false)
    expect(seen).toContainEqual(LIVE)

    // One more tick two seconds later: the cadence comes from the configuration route.
    await vi.advanceTimersByTimeAsync(2000)
    const statsCalls = fetcher.mock.calls.filter(call => String(call[0]) === '/dsh-ram')
    expect(statsCalls.length).toBeGreaterThanOrEqual(2)

    store.stop()
  })

  it('shows no sample — and never throws or logs — when the route is unreachable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetcher = fetcherFor({ stats: () => fail(503) })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(store.getSnapshot().sample).toBeNull()
    expect(store.getSnapshot().unreachable).toBe(true)
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()

    store.stop()
  })

  it('retries on the next tick and recovers when the route answers again', async () => {
    let attempt = 0
    const fetcher = fetcherFor({
      stats: () => {
        attempt += 1
        return attempt === 1 ? fail(503) : ok(LIVE)
      },
    })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getSnapshot().unreachable).toBe(true)

    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getSnapshot().sample).toEqual(LIVE)
    expect(store.getSnapshot().unreachable).toBe(false)

    store.stop()
  })

  it('ignores a malformed body instead of publishing it', async () => {
    const fetcher = fetcherFor({
      stats: () => ok({ rss: 'lots', heapUsed: 1, heapTotal: 2, heapLimit: 3, uptimeSec: 4, pid: 5 }),
    })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)

    expect(store.getSnapshot().sample).toBeNull()
    expect(store.getSnapshot().unreachable).toBe(true)
    store.stop()
  })

  it('clamps a hostile cadence from the configuration route', async () => {
    const fetcher = fetcherFor({
      stats: () => ok(LIVE),
      config: () => ok({ refreshIntervalMs: 1, placement: 'floating' }),
    })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(store.getSnapshot().config).toEqual({ refreshIntervalMs: 500, placement: 'floating' })
    store.stop()
  })

  it('stops polling after stop() and drops in-flight work', async () => {
    const fetcher = fetcherFor({ stats: () => ok(LIVE) })
    const store = storeWith(fetcher)
    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    const before = fetcher.mock.calls.length

    store.stop()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetcher.mock.calls.length).toBe(before)
  })
})

describe('hover pause', () => {
  it('suspends polling between pause() and resume(), then resumes with a fresh read', async () => {
    const fetcher = fetcherFor({ stats: () => ok(LIVE) })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(statsReads(fetcher)).toBe(1)

    store.pause()
    // Ten intervals of hovering: no request, and the rendered value cannot change.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(statsReads(fetcher)).toBe(1)
    expect(store.getSnapshot().sample).toEqual(LIVE)

    store.resume()
    // Resuming reads immediately so the value is fresh as soon as the pointer leaves...
    await vi.advanceTimersByTimeAsync(0)
    expect(statsReads(fetcher)).toBe(2)

    // ...and then keeps the configured cadence.
    await vi.advanceTimersByTimeAsync(2000)
    expect(statsReads(fetcher)).toBe(3)

    store.stop()
  })

  it('drops a read that was in flight when the pointer arrived', async () => {
    let release: (value: FakeResponse) => void = () => {}
    const pending = new Promise<FakeResponse>((resolve) => {
      release = resolve
    })
    const fetcher = fetcherFor({ stats: () => pending })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getSnapshot().sample).toBeNull()

    store.pause()
    release(ok(LIVE))
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    // The aborted read must not publish: no value appears under the cursor, and no false "—".
    expect(store.getSnapshot().sample).toBeNull()
    expect(store.getSnapshot().unreachable).toBe(false)

    store.stop()
  })

  it('keeps the failure state frozen while paused', async () => {
    const fetcher = fetcherFor({ stats: () => fail(503) })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(store.getSnapshot().unreachable).toBe(true)

    store.pause()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(store.getSnapshot().unreachable).toBe(true)
    expect(store.getSnapshot().sample).toBeNull()
    store.stop()
  })

  it('ignores a repeated pause and a resume without a pause', async () => {
    const fetcher = fetcherFor({ stats: () => ok(LIVE) })
    const store = storeWith(fetcher)

    store.start()
    await vi.advanceTimersByTimeAsync(2000)

    store.resume()
    await vi.advanceTimersByTimeAsync(2000)
    expect(statsReads(fetcher)).toBe(2)

    store.pause()
    store.pause()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(statsReads(fetcher)).toBe(2)

    store.stop()
  })
})

