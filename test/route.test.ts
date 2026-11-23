import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_ROUTE,
  ROUTE,
  apply,
  createConfigHandler,
  createStatsHandler,
  readMemorySample,
  type ConnectionGate,
} from '../src/index'
import { resolveMeterConfig } from '../src/config'

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

/** A gate that admits every request, standing in for an authenticated browser cookie. */
const ALLOWED: ConnectionGate = { admit: () => ({ peer: {} }) }
/** A gate that refuses with 401, as the connection service does without a credential. */
const UNAUTHORIZED: ConnectionGate = { admit: () => ({ rejection: 401 }) }
/** A gate that refuses with 403, as it does for an untrusted Host/Origin. */
const FORBIDDEN: ConnectionGate = { admit: () => ({ rejection: 403 }) }

function makeContext(connection: ConnectionGate = ALLOWED) {
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
    connection,
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
    headers: {},
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

function callHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  options: { method?: string; remoteAddress?: string } = {},
): CapturedResponse {
  const { res, captured } = response()
  handler(request(options), res)
  return captured
}

function routeOf(routes: RegisteredRoute[], path: string): RegisteredRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route ${path} not registered`)
  return route
}

describe('authentication fence', () => {
  it('requires the connection credential: no credential is 401 and no memory numbers', () => {
    const { context, routes } = makeContext(UNAUTHORIZED)
    apply(context, undefined)
    const captured = callHandler(routeOf(routes, ROUTE).handler)

    expect(captured.status).toBe(401)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(captured.body)).toEqual({ error: 'unauthorized' })
    expect(captured.body).not.toContain('rss')
    expect(captured.body).not.toContain('heap')
    expect(captured.body).not.toContain('pid')
  })

  it('propagates a forbidden admission from the fence', () => {
    const { context, routes } = makeContext(FORBIDDEN)
    apply(context, undefined)
    const captured = callHandler(routeOf(routes, ROUTE).handler)
    expect(captured.status).toBe(403)
    expect(JSON.parse(captured.body)).toEqual({ error: 'forbidden' })
    expect(captured.body).not.toContain('rss')
  })

  it('passes the request to the fence only for a loopback GET/HEAD', () => {
    const admit = vi.fn(() => ({ peer: {} }))
    const { context, routes } = makeContext({ admit })
    apply(context, undefined)
    const handler = routeOf(routes, ROUTE).handler

    callHandler(handler)
    callHandler(handler, { method: 'HEAD' })
    expect(admit).toHaveBeenCalledTimes(2)

    admit.mockClear()
    callHandler(handler, { remoteAddress: '192.168.1.20' })
    callHandler(handler, { method: 'POST' })
    expect(admit).not.toHaveBeenCalled()
  })

  it('keeps loopback as defence in depth: a non-loopback peer is refused before the fence', () => {
    const { context, routes } = makeContext(ALLOWED)
    apply(context, undefined)
    const captured = callHandler(routeOf(routes, ROUTE).handler, { remoteAddress: '10.0.0.2' })
    expect(captured.status).toBe(403)
    expect(JSON.parse(captured.body)).toEqual({ error: 'loopback only' })
  })

  it('accepts IPv6 loopback spellings', () => {
    const { context, routes } = makeContext(ALLOWED)
    apply(context, undefined)
    for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
      expect(callHandler(routeOf(routes, ROUTE).handler, { remoteAddress }).status).toBe(200)
    }
  })

  it('guards the configuration route the same way', () => {
    const { context, routes } = makeContext(UNAUTHORIZED)
    apply(context, undefined)
    const captured = callHandler(routeOf(routes, CONFIG_ROUTE).handler)
    expect(captured.status).toBe(401)
    expect(JSON.parse(captured.body)).toEqual({ error: 'unauthorized' })
  })
})

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
    const captured = callHandler(routeOf(routes, ROUTE).handler)

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
    for (const key of ['rss', 'heapUsed', 'heapTotal', 'heapLimit', 'uptimeSec', 'pid']) {
      expect(body[key]).toBeTypeOf('number')
    }
    expect(Number.isInteger(body.rss)).toBe(true)
    expect(Number.isInteger(body.heapLimit)).toBe(true)
    expect(Number.isInteger(body.pid)).toBe(true)
    expect(body.rss).toBeGreaterThan(0)
    expect(body.heapLimit).toBeGreaterThan(body.heapUsed as number)
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(body.pid).toBe(process.pid)
  })

  it('reports the process ceiling from v8, not a constant', () => {
    const live = readMemorySample()
    expect(live.heapLimit).toBeGreaterThan(1024 ** 3)
    expect(live.heapLimit).toBeLessThan(Number.MAX_SAFE_INTEGER)
    const captured = callHandler(createStatsHandler(ALLOWED))
    expect((JSON.parse(captured.body) as { heapLimit: number }).heapLimit).toBe(live.heapLimit)
  })

  it('answers HEAD with the GET headers and no body', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const captured = callHandler(routeOf(routes, ROUTE).handler, { method: 'HEAD' })

    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(Number(captured.headers['content-length'])).toBeGreaterThan(0)
    expect(captured.body).toBe('')
  })

  it('answers HEAD of the configuration route with the GET length and no body', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const handler = routeOf(routes, CONFIG_ROUTE).handler
    const get = callHandler(handler)
    const head = callHandler(handler, { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers).toEqual(get.headers)
    expect(head.body).toBe('')
  })

  it('rejects methods other than GET and HEAD', () => {
    const { context, routes } = makeContext()
    apply(context, undefined)
    const handler = routeOf(routes, ROUTE).handler
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const captured = callHandler(handler, { method })
      expect(captured.status).toBe(405)
      expect(JSON.parse(captured.body)).toEqual({ error: 'method not allowed' })
    }
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
    const captured = callHandler(routeOf(routes, CONFIG_ROUTE).handler)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ refreshIntervalMs: 2000, placement: 'sidebar-footer' })
  })

  it('reports clamped values for a raw row config', () => {
    const { context, routes } = makeContext()
    apply(context, { refreshIntervalMs: 1, placement: 'floating', ignored: 'x' })
    const captured = callHandler(routeOf(routes, CONFIG_ROUTE).handler)
    expect(JSON.parse(captured.body)).toEqual({ refreshIntervalMs: 500, placement: 'floating' })
  })

  it('builds a handler for a resolved config directly', () => {
    const captured = callHandler(createConfigHandler(resolveMeterConfig({ placement: 'floating' }), ALLOWED))
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ refreshIntervalMs: 2000, placement: 'floating' })
  })
})

describe('over a real HTTP connection', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.close(() => resolve())
    })))
    servers.length = 0
  })

  async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
    const server = createServer((req, res) => {
      handler(req, res)
    })
    servers.push(server)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('server has no port')
    return `http://127.0.0.1:${address.port}`
  }

  function mountedHandler(gate: ConnectionGate, path: string) {
    const { context, routes } = makeContext(gate)
    apply(context, undefined)
    return routeOf(routes, path).handler
  }

  it('serves GET and HEAD with identical headers, and HEAD without a body', async () => {
    const base = await serve(mountedHandler(ALLOWED, ROUTE))

    const get = await fetch(`${base}${ROUTE}`)
    expect(get.status).toBe(200)
    const body = await get.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['heapLimit', 'heapTotal', 'heapUsed', 'pid', 'rss', 'uptimeSec'])

    const head = await fetch(`${base}${ROUTE}`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await head.text()).toBe('')
  })

  it('refuses an unauthenticated GET without leaking memory numbers', async () => {
    const base = await serve(mountedHandler(UNAUTHORIZED, ROUTE))
    const response = await fetch(`${base}${ROUTE}`)
    const text = await response.text()

    expect(response.status).toBe(401)
    expect(text).toBe('{"error":"unauthorized"}')
    expect(text).not.toContain('rss')
  })

  it('answers POST with 405', async () => {
    const base = await serve(mountedHandler(ALLOWED, ROUTE))
    const response = await fetch(`${base}${ROUTE}`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})
