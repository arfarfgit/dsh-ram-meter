/**
 * The pill component.
 *
 * React arrives as an argument instead of an import: the Client bundle is a factory registered in
 * `window.__ModuleLoader__`, and `react` is answered by the shell's static module table at require
 * time. Keeping the component in a factory function also keeps this module free of runtime imports.
 */
import type { Placement } from '../config'
import {
  TONE_COLORS,
  buildTooltip,
  formatCeiling,
  formatGigabytes,
  formatPercent,
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

    // Every placement stays registered so a configuration change needs no re-registration; only the
    // configured one renders, the others return nothing.
    if (state.config.placement !== placement) return null

    const { compact, container } = styleFor(placement, props.wide)
    const sample = state.sample
    const percentage = sample ? percentageOf(sample.rss, sample.heapLimit) : 0
    const tone = toneFor(percentage)
    const color = TONE_COLORS[tone]

    const title = sample ? buildTooltip(sample, labels) : labels.unavailable
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
      role: 'status',
      'aria-label': label,
      title,
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
        }, labels.ram),
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
