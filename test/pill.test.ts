import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPill, type ReactApi } from '../src/client/pill'
import { createMeterStore } from '../src/client/store'
import { EN_LABELS, type HeapSample } from '../src/format'
import type { MeterState, MeterStore } from '../src/client/store'

const GIB = 1024 ** 3

function sample(overrides: Partial<HeapSample> = {}): HeapSample {
  return {
    rss: 1.4 * GIB,
    heapUsed: 0.4 * GIB,
    heapTotal: 0.6 * GIB,
    heapLimit: 16 * GIB,
    uptimeSec: 120,
    pid: 4242,
    ...overrides,
  }
}

interface Element {
  type: unknown
  props: Record<string, unknown> & { children?: unknown[] }
}

interface Slot {
  value?: unknown
  ref?: { current: unknown }
  effect?: { deps?: readonly unknown[]; cleanup?: () => void }
}

/**
 * A deliberately small React stand-in: enough hook semantics (stable slots, effect deps and cleanup)
 * to mount the real pill component and unmount it, without pulling a DOM implementation into the
 * package's devDependencies.
 */
function createTestReact() {
  const React: ReactApi = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), ...(children.length > 0 ? { children } : {}) } }
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
    useState<S>(initial: S) {
      const index = cursor()
      const slot = (slots[index] ??= { value: initial })
      return [slot.value as S, (next: S) => {
        slot.value = next
        rerender()
      }]
    },
    useRef<T>(initial: T) {
      const index = cursor()
      const slot = (slots[index] ??= {})
      slot.ref ??= { current: initial }
      return slot.ref as { current: T }
    },
    useEffect(effect, deps) {
      const index = cursor()
      pending.push({ index, effect, deps })
    },
  }

  const slots: Slot[] = []
  let position = 0
  let pending: { index: number; effect: () => void | (() => void); deps?: readonly unknown[] }[] = []
  let renderTarget: (() => unknown) | undefined
  let tree: Element | null = null
  let alive = false

  function cursor(): number {
    const index = position
    position += 1
    return index
  }

  function render(): Element | null {
    if (renderTarget === undefined) throw new Error('renderer is not mounted')
    position = 0
    pending = []
    tree = renderTarget() as Element | null
    for (const { index, effect, deps } of pending) {
      const slot = (slots[index] ??= {})
      const previous = slot.effect
      const unchanged = previous !== undefined && deps !== undefined && previous.deps !== undefined
        && deps.length === previous.deps.length
        && deps.every((value, at) => Object.is(value, previous.deps?.[at]))
      if (unchanged) continue
      previous?.cleanup?.()
      const cleanup = effect()
      slot.effect = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
    }
    return tree
  }

  function rerender(): void {
    if (!alive) return
    render()
  }

  return {
    React,
    mount(component: () => unknown): Element {
      renderTarget = component
      alive = true
      const next = render()
      if (next === null) throw new Error('component rendered nothing')
      return next
    },
    /** Simulate an unrelated re-render (a store notification React would deliver). */
    flush(): Element {
      const next = render()
      if (next === null) throw new Error('component rendered nothing')
      return next
    },
    unmount(): void {
      alive = false
      for (const slot of slots) slot.effect?.cleanup?.()
    },
  }
}

/** A store whose snapshot the test controls; records pause/resume reasons. */
function fakeStore(initial: HeapSample | null, placement: MeterState['config']['placement'] = 'sidebar-footer') {
  let state: MeterState = {
    sample: initial,
    unreachable: false,
    config: { refreshIntervalMs: 2000, placement },
  }
  const pause = vi.fn<(reason: string) => void>()
  const resume = vi.fn<(reason: string) => void>()
  const store = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    start: () => {},
    stop: () => {},
    pause,
    resume,
    setSample(next: HeapSample | null) {
      state = { ...state, sample: next }
    },
  }
  return store as unknown as MeterStore & { setSample(next: HeapSample | null): void; pause: typeof pause; resume: typeof resume }
}

function mountPill(store: MeterStore) {
  const renderer = createTestReact()
  const Pill = createPill(renderer.React)
  const tree = renderer.mount(() => Pill({ placement: 'sidebar-footer', store, labels: EN_LABELS }))
  return { renderer, tree }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pill accessibility and wording', () => {
  it('is a named group that does not announce every refresh', () => {
    const store = fakeStore(sample())
    const { tree } = mountPill(store)

    expect(tree.props.role).toBe('group')
    expect(tree.props['aria-live']).toBe('off')
    expect(String(tree.props['aria-label'])).toBe(
      'RAM meter: RSS 1.4 GB · 8.8% of the 16 GB V8 heap ceiling',
    )
  })

  it('labels the value as RSS against the V8 heap ceiling, not RAM used', () => {
    const store = fakeStore(sample())
    const { tree } = mountPill(store)
    const title = String(tree.props.title)
    expect(title.split('\n')[0]).toBe('RSS 1.4 GB · 8.8% of the 16 GB V8 heap ceiling')
    expect(title).not.toMatch(/RAM used/i)
  })

  it('forces the red tone and explains an above-ceiling sample', () => {
    const store = fakeStore(sample({ rss: 20 * GIB }))
    const { tree } = mountPill(store)

    expect(tree.props['data-ram-tone']).toBe('red')
    expect(tree.props['data-ram-over-ceiling']).toBe('true')
    expect(String(tree.props.title).split('\n')[0]).toBe(
      'RSS 20.0 GB is above the 16 GB V8 heap ceiling (clamped to 100%)',
    )
    expect(String(tree.props['aria-label'])).toContain('is above the 16 GB V8 heap ceiling')
  })

  it('shows the em dash and a neutral tone when no sample arrived', () => {
    const store = fakeStore(null)
    const { tree } = mountPill(store)
    expect(tree.props['data-ram-state']).toBe('unavailable')
    expect(String(tree.props['aria-label'])).toBe(EN_LABELS.unavailable)
  })
})

describe('pill hover', () => {
  it('pauses on pointerenter and resumes on pointerleave, exactly once per reason', () => {
    const store = fakeStore(sample())
    const { tree } = mountPill(store)

    const onEnter = tree.props.onPointerEnter as () => void
    const onLeave = tree.props.onPointerLeave as () => void

    onEnter()
    expect(store.pause).toHaveBeenCalledTimes(1)
    expect(store.pause).toHaveBeenCalledWith('hover')

    // A second enter without a leave must not double-hold the reason.
    onEnter()
    expect(store.pause).toHaveBeenCalledTimes(1)

    onLeave()
    expect(store.resume).toHaveBeenCalledTimes(1)
    expect(store.resume).toHaveBeenCalledWith('hover')

    // A stray leave must not release a reason that is no longer held.
    onLeave()
    expect(store.resume).toHaveBeenCalledTimes(1)
  })

  it('freezes the tooltip while hovered, and refreshes it after leaving', () => {
    const store = fakeStore(sample())
    const { renderer, tree } = mountPill(store)
    const firstTitle = String(tree.props.title)

    ;(tree.props.onPointerEnter as () => void)()

    // A stray re-render with a new sample (a store notification) must not rewrite the open tooltip.
    store.setSample(sample({ rss: 2.9 * GIB, uptimeSec: 180 }))
    const whileHovered = renderer.flush()
    expect(String(whileHovered.props.title)).toBe(firstTitle)
    expect(String(whileHovered.props.title)).toContain('1.4 GB')

    // Leaving re-applies the live text.
    ;(whileHovered.props.onPointerLeave as () => void)()
    const afterLeave = renderer.flush()
    expect(String(afterLeave.props.title)).toContain('2.9 GB')
  })

  it('writes no ref during render: the frozen title only arrives through state', () => {
    const store = fakeStore(sample())
    const { renderer, tree } = mountPill(store)
    const firstTitle = String(tree.props.title)

    // Re-render without any pointer event: the committed title must be unchanged.
    const again = renderer.flush()
    expect(String(again.props.title)).toBe(firstTitle)
  })
})

describe('pill unmount', () => {
  it('releases the hover reason when it unmounts while hovered, so polling resumes', async () => {
    const urls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...sample() }),
      }
    }) as unknown as typeof fetch
    const reads = (): number => urls.filter(url => url === '/dsh-ram').length
    const visibility = {
      hidden: false,
      subscribe: () => () => {},
    }
    const store = createMeterStore({ fetcher, visibility })
    store.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(reads()).toBe(1)

    const renderer = createTestReact()
    const Pill = createPill(renderer.React)
    const tree = renderer.mount(() => Pill({ placement: 'sidebar-footer', store, labels: EN_LABELS }))
    ;(tree.props.onPointerEnter as () => void)()

    // While hovered the store stays quiet...
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reads()).toBe(1)

    // ...and unmounting releases the reason, so the poll comes back.
    renderer.unmount()
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toBe(2)

    store.stop()
  })
})
