/**
 * The pill component.
 *
 * React arrives as an argument instead of an import: the Client bundle is a factory registered in
 * `window.__ModuleLoader__`, and `react` is answered by the shell's static module table at require
 * time. Keeping the component in a factory function also keeps this module free of runtime imports.
 *
 * Tooltip rules: the native tooltip is dismissed by the browser whenever its `title` changes, so
 * the title must not change while it is open. Hovering pauses the poll (store reason "hover") and
 * freezes the text at pointerenter in state; nothing here writes a ref during render, because a
 * discarded render must not advance a value a later committed view could display.
 */
import type { Placement } from '../config'
import {
  TONE_COLORS,
  buildTooltip,
  formatCeiling,
  formatGigabytes,
  formatPercent,
  isOverCeiling,
  percentageOf,
  pillSummary,
  toneFor,
  type MeterLabels,
} from '../format'
import type { MeterState, MeterStore } from './store'

/** The subset of the React API this component uses. */
export interface ReactApi {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useSyncExternalStore<T>(subscribe: (onChange: () => void) => () => void, getSnapshot: () => T): T
  useState<S>(initial: S): [S, (next: S) => void]
  useRef<T>(initial: T): { current: T }
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

export interface PillProps {
  readonly placement: Placement
  readonly store: MeterStore
  readonly labels: MeterLabels
  /** The sidebar publishes whether it renders wide content (false = 56 px rail). */
  readonly wide?: boolean
}

const UNAVAILABLE = '\u2014'

interface PlacementStyle {
  readonly container: Record<string, string | number>
  readonly compact: boolean
}

function styleFor(placement: Placement, wide: boolean | undefined): PlacementStyle {
  if (placement === 'floating') {
    return {
      compact: false,
      container: {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        width: '188px',
        zIndex: 40,
        pointerEvents: 'auto',
      },
    }
  }
  if (placement === 'composer-dock') {
    return {
      compact: false,
      container: { width: '188px', flex: '0 0 auto' },
    }
  }
  return {
    compact: wide === false,
    container: { width: '100%' },
  }
}

/**
 * Build the pill component for one React instance.
 * @param React - the module-table React.
 * @returns a component receiving {@link PillProps}.
 */
export function createPill(React: ReactApi) {
  const h = React.createElement

  return function RamMeterPill(props: PillProps): unknown {
    const { placement, store, labels } = props
    const state = React.useSyncExternalStore<MeterState>(store.subscribe, store.getSnapshot)
    const active = state.config.placement === placement
    const [hovered, setHovered] = React.useState(false)
    const [frozenTitle, setFrozenTitle] = React.useState<string | null>(null)
    const holdsHover = React.useRef(false)

    const releaseHover = (): void => {
      if (!holdsHover.current) return
      holdsHover.current = false
      store.resume('hover')
    }

    // A pill removed while hovered never receives pointerleave: release the reason on unmount.
    React.useEffect(() => () => {
      releaseHover()
    }, [])
    // A configuration change moves the pill to another seat; the old seat stops rendering and must
    // not keep holding the hover reason.
    React.useEffect(() => {
      if (!active) releaseHover()
    }, [active])

    // Every placement stays registered so a configuration change needs no re-registration; only the
    // configured one renders, the others return nothing.
    if (!active) return null

    const { compact, container } = styleFor(placement, props.wide)
    const sample = state.sample
    const percentage = sample ? percentageOf(sample.rss, sample.heapLimit) : 0
    const overCeiling = sample !== null && isOverCeiling(sample)
    const tone = toneFor(percentage, overCeiling)
    const color = TONE_COLORS[tone]

    // The committed tooltip text for this sample. While hovered the frozen copy is what renders, so
    // a stray re-render re-applies the identical string and the open tooltip is not dismissed.
    const liveTitle = sample ? buildTooltip(sample, labels) : labels.unavailable
    const title = hovered && frozenTitle !== null ? frozenTitle : liveTitle

    const label = sample ? pillSummary(sample, labels) : labels.unavailable
    const value = sample ? formatGigabytes(sample.rss) : UNAVAILABLE
    const percentText = sample ? formatPercent(percentage) : UNAVAILABLE
    const ceilingText = sample ? formatCeiling(sample.heapLimit) : ''

    const tertiary = 'var(--dsw-alias-label-tertiary, #8b98ab)'
    const border = 'var(--dsw-alias-border-l2, rgba(255,255,255,0.12))'

    return h('div', {
      'data-dsh-ram-meter': '',
      'data-ram-placement': placement,
      'data-ram-state': sample ? 'ok' : 'unavailable',
      'data-ram-rss': sample ? String(sample.rss) : '',
      'data-ram-pct': sample ? percentage.toFixed(1) : '',
      'data-ram-tone': sample ? tone : 'neutral',
      'data-ram-over-ceiling': overCeiling ? 'true' : 'false',
      // A named group whose label is read on demand: `status` would announce the new value every
      // refresh, which is noise for a meter that changes every two seconds.
      role: 'group',
      'aria-live': 'off',
      'aria-label': label,
      title,
      // Reading the tooltip must not race the poll: hover stops it, leaving starts it again.
      onPointerEnter: () => {
        if (!holdsHover.current) {
          holdsHover.current = true
          store.pause('hover')
        }
        setFrozenTitle(liveTitle)
        setHovered(true)
      },
      onPointerLeave: () => {
        releaseHover()
        setFrozenTitle(null)
        setHovered(false)
      },
      style: {
        boxSizing: 'border-box',
        minWidth: 0,
        padding: compact ? '5px 7px 6px' : '6px 9px 7px',
        border: `1px solid ${border}`,
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.05))',
        color: 'var(--dsw-alias-label-primary, #e8edf5)',
        font: 'inherit',
        fontSize: compact ? '10px' : '11px',
        lineHeight: '14px',
        cursor: 'default',
        userSelect: 'none',
        ...container,
      },
    }, [
      h('div', {
        key: 'row',
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: '4px',
          minWidth: 0,
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        },
      }, [
        h('span', {
          key: 'label',
          style: {
            color: tertiary,
            fontSize: compact ? '9px' : '10px',
            letterSpacing: '0.4px',
            fontWeight: 600,
          },
        }, labels.rss),
        h('span', { key: 'value', style: { fontWeight: 600 } }, value),
        h('span', { key: 'sep', style: { color: tertiary } }, '\u00b7'),
        h('span', { key: 'pct', style: { color, fontWeight: 600 } }, percentText),
        h('span', {
          key: 'ceiling',
          style: {
            marginLeft: 'auto',
            color: tertiary,
            fontSize: compact ? '9px' : '10px',
          },
        }, ceilingText),
      ]),
      h('div', {
        key: 'track',
        'aria-hidden': 'true',
        style: {
          height: '3px',
          marginTop: '5px',
          overflow: 'hidden',
          borderRadius: '2px',
          background: border,
        },
      }, h('div', {
        style: {
          width: `${percentage.toFixed(2)}%`,
          height: '100%',
          borderRadius: '2px',
          background: color,
          transition: 'width 0.35s ease, background-color 0.35s ease',
        },
      })),
    ])
  }
}
