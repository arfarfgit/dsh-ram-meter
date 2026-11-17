/**
 * Client plugin logic, kept apart from the module-loader entry so it stays a normal ES module:
 * tests import this file directly, while `./index.ts` is the side-effect-only bundle entry.
 */
import { PLACEMENTS, type Placement } from '../config'
import { EN_LABELS, type MeterLabels } from '../format'
import { createPill, type ReactApi } from './pill'
import { createMeterStore, type MeterStore } from './store'

/** One Client slot per placement. */
export const SLOT_BY_PLACEMENT: Record<Placement, string> = {
  'sidebar-footer': 'sidebar.footer.action',
  'composer-dock': 'conversation.composer.dock',
  'floating': 'shell.overlay',
}

/** Locale namespace owned by this plugin. */
export const LOCALE_NAMESPACE = 'ram-meter'

/** The subset of the Client context this plugin uses. */
export interface ClientContext {
  effect(effect: () => (() => void) | void, label?: string): void
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, MeterLabels>): () => void
    bind(namespace: string): (key: keyof MeterLabels) => string
  }
  readonly slots: {
    inject(name: string, callback: () => () => void): () => void
    register(
      options: { name: string; id: string; order?: number },
      component: (props: Record<string, unknown>) => unknown,
    ): () => void
  }
  readonly logger?: { error?(message: unknown): void }
}

export interface RegisterOptions {
  /** Module request used for React; the loader answers `react` from its static table. */
  require(module: string): unknown
  /** Store override for tests. */
  store?: MeterStore
}

/**
 * Register the pill in all three placement slots for one Client fiber.
 * @param ctx - Client context providing `slots` and `locale`.
 * @param options - React access and an optional store override.
 */
export function registerPill(ctx: ClientContext, options: RegisterOptions): void {
  const React = options.require('react') as ReactApi
  const Pill = createPill(React)

  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { en: EN_LABELS }), 'dsh-ram-meter: locale')
  const t = ctx.locale.bind(LOCALE_NAMESPACE)

  const read = (key: keyof MeterLabels): string => {
    const value = t(key)
    return typeof value === 'string' && value !== '' ? value : EN_LABELS[key]
  }
  const labels: MeterLabels = {
    ram: read('ram'),
    heap: read('heap'),
    of: read('of'),
    ceiling: read('ceiling'),
    pid: read('pid'),
    uptime: read('uptime'),
    unavailable: read('unavailable'),
  }

  const store = options.store ?? createMeterStore()
  ctx.effect(() => {
    store.start()
    return () => store.stop()
  }, 'dsh-ram-meter: polling')

  for (const placement of PLACEMENTS) {
    const slot = SLOT_BY_PLACEMENT[placement]
    ctx.effect(
      () => ctx.slots.inject(slot, () => ctx.slots.register({
        name: slot,
        id: `ram-meter-${placement}`,
        order: 100,
      }, (props) => React.createElement(Pill, { ...props, placement, store, labels }))),
      `dsh-ram-meter: ${slot}`,
    )
  }
}

/**
 * The plugin object the loader materializes.
 * @param requireModule - module request handed in by the loader.
 * @returns a Cordis-shaped Client plugin.
 */
export function createPlugin(requireModule: (module: string) => unknown) {
  return {
    inject: ['slots', 'locale'],
    apply(ctx: ClientContext): void {
      registerPill(ctx, { require: requireModule })
    },
  }
}
