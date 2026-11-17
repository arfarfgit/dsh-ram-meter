/**
 * Client bundle entry.
 *
 * The build emits this file as the package's `./client` script: a lazy factory registered under the
 * package name — the format @deepseek-ai/dsh-client-modules serves and the shell's module table
 * materializes. `react` is the only module request, answered by that table; every other value is
 * bundled. This entry deliberately exports nothing, so the emitted script is a plain script with no
 * module syntax: the page loads it directly and the loader keeps the factory until first import.
 */
import { createPlugin } from './plugin'

/** Must equal the package name: the loader keys the factory and the boot graph row by it. */
const PACKAGE_NAME = '@npmghost/dsh-ram-meter'

interface ModuleLoader {
  load(entry: { id: string; factory(require: (module: string) => unknown): unknown }): void
}

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoader
  }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: PACKAGE_NAME,
    factory(require) {
      return createPlugin(require)
    },
  })
}
