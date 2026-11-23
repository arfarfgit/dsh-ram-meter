/**
 * Host half of @npmghost/dsh-ram-meter.
 *
 * Two exact routes on the host's own Web server:
 *   GET/HEAD /dsh-ram         the six measured fields of THIS process
 *   GET/HEAD /dsh-ram/config  the resolved plugin configuration the Client must mount with
 *
 * Both routes require the same browser-trust credential the `/api` fence uses: the `connection`
 * service's `admit()`. That call applies the Host/Origin trust fence and then the signed, authority
 * bound browser cookie (or an API credential). A loopback address alone is not authentication — a
 * reverse proxy makes every peer look like 127.0.0.1 — so loopback is only defence in depth here.
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

/**
 * The subset of the host's Connection service (`ctx.connection`, from @deepseek-ai/dsh-client-connection)
 * this plugin relies on.
 *
 * `admit` is the `/api` fence itself: it answers a Peer for a trusted, authenticated request and a
 * rejection status otherwise. Reusing it means this plugin inherits the host's cookie lifetime,
 * authority binding and trusted-host configuration instead of inventing a parallel scheme.
 * `HostConnectionService.admit` reads:
 *   `if (!this.isTrusted(request)) return { rejection: 403 }`
 *   `if (this.browserAuth.isAuthenticated(request, secure)) return { peer: this.browserPeer }`
 *   `return record === undefined ? { rejection: 401 } : { peer: record.peer }`
 */
export interface ConnectionGate {
  admit(request: IncomingMessage): { readonly rejection: 401 | 403 } | { readonly peer: unknown }
}

/**
 * Loopback-only as defence in depth, never as authentication: the credential check below is what
 * protects the numbers, and this test only narrows who may reach the credential at all. A
 * deployment that serves remote browsers through `trustedHosts` (a deliberate host configuration)
 * would have to relax or make this configurable; the default posture stays closed.
 */
function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function isHead(req: IncomingMessage): boolean {
  return req.method === 'HEAD'
}

function sendJson(res: ServerResponse, status: number, payload: unknown, head = false): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  // HEAD keeps the GET headers, including the length a GET would have sent, and no body.
  res.end(head ? undefined : body)
}

function reject(res: ServerResponse, status: number, error: string, head = false): void {
  sendJson(res, status, { error }, head)
}

/**
 * Apply method, loopback and credential policy, answering the request when it may not proceed.
 * @returns true only when the caller may send the payload.
 */
function admit(req: IncomingMessage, res: ServerResponse, connection: ConnectionGate): boolean {
  if (req.method !== 'GET' && !isHead(req)) {
    reject(res, 405, 'method not allowed')
    return false
  }
  if (!isLoopback(req)) {
    reject(res, 403, 'loopback only', isHead(req))
    return false
  }
  // Same fence as /api: a reverse proxy that rewrites the peer address cannot satisfy it.
  const admission = connection.admit(req)
  if ('rejection' in admission) {
    reject(res, admission.rejection, admission.rejection === 401 ? 'unauthorized' : 'forbidden', isHead(req))
    return false
  }
  return true
}

function routeHandler(
  connection: ConnectionGate,
  payload: () => unknown,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (!admit(req, res, connection)) return
    sendJson(res, 200, payload(), isHead(req))
  }
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
 * Build the `GET|HEAD /dsh-ram` handler.
 * @param connection - the host's Connection service, used as the authentication fence.
 * @returns a credentialed, loopback-only, no-store JSON handler.
 */
export function createStatsHandler(
  connection: ConnectionGate,
): (req: IncomingMessage, res: ServerResponse) => void {
  return routeHandler(connection, readMemorySample)
}

/**
 * Build the `GET|HEAD /dsh-ram/config` handler.
 * @param config - the resolved configuration of this plugin row.
 * @param connection - the host's Connection service, used as the authentication fence.
 * @returns a credentialed, loopback-only, no-store JSON handler.
 */
export function createConfigHandler(
  config: MeterConfig,
  connection: ConnectionGate,
): (req: IncomingMessage, res: ServerResponse) => void {
  return routeHandler(connection, () => config)
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
  /** The host's Connection service; `admit` is the same fence the `/api` transport uses. */
  readonly connection: ConnectionGate
  effect(effect: () => (() => void) | void, label?: string): void
  readonly logger?: { info?(message: string): void }
}

/** Services required before this plugin can activate: no Web server, no credential fence, no routes. */
export const inject = ['webServer', 'connection']

/**
 * Register the routes for one host lifetime.
 * @param ctx - host context providing the Web server and Connection services.
 * @param config - raw row config; validated and clamped here.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const resolved = resolveMeterConfig(config)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: createStatsHandler(ctx.connection),
    }),
    `dsh-ram-meter: GET ${ROUTE}`,
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE,
      handler: createConfigHandler(resolved, ctx.connection),
    }),
    `dsh-ram-meter: GET ${CONFIG_ROUTE}`,
  )

  try {
    ctx.logger?.info?.(`[dsh-ram-meter] routes registered: GET ${ROUTE}, GET ${CONFIG_ROUTE}`)
  } catch {
    // Logging is optional; a missing logger must never break activation.
  }
}

export { Config } from './config'
