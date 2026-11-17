import { defineConfig } from 'tsdown'

/** Both artifacts are ESM inside a `"type": "module"` package, so emit `.js`, not `.mjs`. */
const outExtensions = () => ({ js: '.js' })

/**
 * Two independent artifacts, because the halves have different runtimes:
 * - `lib/index.js` runs in the DSH host process (Node), so `node:` builtins stay external.
 * - `lib/client.js` runs in the Web page through `window.__ModuleLoader__`, so it must be a
 *   single self-contained script whose only module request is the `require('react')` the
 *   loader answers from the shell's static module table.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    clean: true,
    outExtensions,
    dts: false,
    sourcemap: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    clean: false,
    outExtensions,
    dts: false,
    sourcemap: false,
  },
])

