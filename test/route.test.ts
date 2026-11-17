import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { CONFIG_ROUTE, ROUTE, apply, createStatsHandler, readMemorySample } from '../src/index'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

function makeContext() {
  const routes: RegisteredRoute[] = []
  const effects: { label: string | undefined; disposer: unknown }[] = []
  const context = {
    webServer: {
      register(route: RegisteredRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    effect(effect: () => (() => void) | void, label?: string) {
      effects.push({ label, disposer: effect() })
    },
    logger: { info() {} },
  }
  return { context, routes, effects }
}

function request(options: { method?: string; remoteAddress?: string } = {}): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

function response(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      return res
    },
    end(body?: string) {
      captured.body = body ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function callRoute(route: RegisteredRoute, req: IncomingMessage): CapturedResponse {
  const { res, captured } = response()
  route.handler(req, res)
  return captured
}

describe('GET /dsh-ram', () => {
  it('registers both routes as exact paths and keeps their disposers', () => {
    const { context, routes, effects } = makeContext()
    apply(context, undefined)

    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', ROUTE],
      ['exact', CONFIG_ROUTE],
    ])
    expect(effects).toHaveLength(2)
    for (const effect of effects) expect(typeof effect.disposer).toBe('function')
  })

  it('answers the six fields with the right types', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === ROUTE)
    expect(route).toBeDefined()

    const captured = callRoute(route as RegisteredRoute, request())
    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.headers['content-length']).toBe(String(Buffer.byteLength(captured.body)))

    const body = JSON.parse(captured.body) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual([
      'heapLimit',
      'heapTotal',
      'heapUsed',
      'pid',
      'rss',
      'uptimeSec',
    ])
    expect(body.rss).toBeTypeOf('number')
    expect(body.heapUsed).toBeTypeOf('number')
    expect(body.heapTotal).toBeTypeOf('number')
    expect(body.heapLimit).toBeTypeOf('number')
    expect(body.uptimeSec).toBeTypeOf('number')
    expect(body.pid).toBeTypeOf('number')

    expect(Number.isInteger(body.rss)).toBe(true)
    expect(Number.isInteger(body.heapLimit)).toBe(true)
    expect(Number.isInteger(body.pid)).toBe(true)

    expect(body.rss).toBeGreaterThan(0)
    expect(body.heapLimit).toBeGreaterThan(body.heapUsed as number)
    expect(body.heapTotal).toBeGreaterThan(0)
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(body.pid).toBe(process.pid)
  })

  it('reports the process ceiling from v8, not a constant', () => {
    const live = readMemorySample()
    expect(live.heapLimit).toBeGreaterThan(1024 ** 3)
    expect(live.heapLimit).toBeLessThan(Number.MAX_SAFE_INTEGER)
    // The denominator the pill uses is the same number the route reports.
    const { res, captured } = response()
    createStatsHandler()(request(), res)
    expect((JSON.parse(captured.body) as { heapLimit: number }).heapLimit).toBe(live.heapLimit)
  })

  it('rejects a non-loopback peer', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === ROUTE) as RegisteredRoute
    const captured = callRoute(route, request({ remoteAddress: '192.168.1.20' }))
    expect(captured.status).toBe(403)
    expect(JSON.parse(captured.body)).toEqual({ error: 'loopback only' })
  })

  it('accepts IPv6 loopback spellings', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === ROUTE) as RegisteredRoute
    for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
      expect(callRoute(route, request({ remoteAddress })).status).toBe(200)
    }
  })

  it('rejects methods other than GET', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === ROUTE) as RegisteredRoute
    const captured = callRoute(route, request({ method: 'POST' }))
    expect(captured.status).toBe(405)
    expect(JSON.parse(captured.body)).toEqual({ error: 'method not allowed' })
  })

  it('disposes both registration effects', () => {
    const { context, routes, effects } = makeContext()
    apply(context, undefined)
    expect(routes).toHaveLength(2)
    for (const effect of effects) (effect.disposer as () => void)()
    expect(routes).toHaveLength(0)
  })
})

describe('GET /dsh-ram/config', () => {
  it('reports the resolved defaults when the row has no config', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === CONFIG_ROUTE) as RegisteredRoute
    const captured = callRoute(route, request())
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ refreshIntervalMs: 2000, placement: 'sidebar-footer' })
  })

  it('reports clamped values for a raw row config', () => {
    const { context, routes } = makeContext()
    apply(context, { refreshIntervalMs: 1, placement: 'floating', ignored: 'x' })
    const route = routes.find(candidate => candidate.path === CONFIG_ROUTE) as RegisteredRoute
    expect(JSON.parse(callRoute(route, request()).body)).toEqual({
      refreshIntervalMs: 500,
      placement: 'floating',
    })
  })

  it('is loopback-only and GET-only', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const route = routes.find(candidate => candidate.path === CONFIG_ROUTE) as RegisteredRoute
    expect(callRoute(route, request({ remoteAddress: '10.0.0.2' })).status).toBe(403)
    expect(callRoute(route, request({ method: 'DELETE' })).status).toBe(405)
  })
})
