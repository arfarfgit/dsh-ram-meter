/**
 * Host half of @npmghost/dsh-ram-meter.
 *
 * Two exact routes on the host's own Web server:
 *   GET /dsh-ram         the six measured fields of THIS process
 *   GET /dsh-ram/config  the resolved plugin configuration the Client must mount with
 *
 * The route reports this process, not another process: the host is the process whose V8 heap
 * ceiling matters, and `process.memoryUsage()` plus `v8.getHeapStatistics()` are exact and cheap.
 * The ceiling is therefore always measured (`heap_size_limit`), never assumed — a stock host and a
 * host launched with a larger `--max-old-space-size` report different, correct numbers.
 *
 * This module imports `node:v8` and nothing else, so it resolves in any profile that installs only
 * this bundle: DSH packages are provided by the running host and are never imported at runtime.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import v8 from 'node:v8'
import { resolveMeterConfig, type MeterConfig } from './config'
import type { HeapSample } from './format'

/** Route serving one measured sample. */
export const ROUTE = '/dsh-ram'

/** Route serving the resolved configuration. */
export const CONFIG_ROUTE = '/dsh-ram/config'

/** The host service this plugin needs; `webServer` is provided by @deepseek-ai/dsh-host-webserver. */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * Read this process's memory state.
 *
 * `heap_size_limit` is the V8 ceiling the host really runs with; it is the meter's denominator.
 * @returns the six fields the pill and its tooltip need.
 */
export function readMemorySample(): HeapSample {
  const memory = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    heapLimit: heap.heap_size_limit,
    uptimeSec: Number(process.uptime().toFixed(3)),
    pid: process.pid,
  }
}

/**
 * Build the `GET /dsh-ram` handler.
 * @returns a loopback-only, no-store JSON handler.
 */
export function createStatsHandler(): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'loopback only' })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    sendJson(res, 200, readMemorySample())
  }
}

/**
 * Build the `GET /dsh-ram/config` handler.
 * @param config - the resolved configuration of this plugin row.
 * @returns a loopback-only, no-store JSON handler.
 */
export function createConfigHandler(
  config: MeterConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'loopback only' })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    sendJson(res, 200, config)
  }
}

/** Minimal shape of the host services this plugin uses. */
export interface HostContext {
  readonly webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void
    }): () => void
  }
  effect(effect: () => (() => void) | void, label?: string): void
  readonly logger?: { info?(message: string): void }
}

/** Services required before this plugin can activate. */
export const inject = ['webServer']

/**
 * Register the routes for one host lifetime.
 * @param ctx - host context providing the Web server service.
 * @param config - raw row config; validated and clamped here.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const resolved = resolveMeterConfig(config)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: createStatsHandler() }),
    `dsh-ram-meter: GET ${ROUTE}`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: CONFIG_ROUTE, handler: createConfigHandler(resolved) }),
    `dsh-ram-meter: GET ${CONFIG_ROUTE}`,
  )

  try {
    ctx.logger?.info?.(`[dsh-ram-meter] routes registered: GET ${ROUTE}, GET ${CONFIG_ROUTE}`)
  } catch {
    // Logging is optional; a missing logger must never break activation.
  }
}

export { Config } from './config'
