#!/usr/bin/env node
/**
 * End-to-end check for the packed plugin, driven through Edge's DevTools protocol.
 *
 * It boots a real DSH host for the given profile, opens the authenticated page in headless Edge,
 * and asserts what a user sees: the pill is in the DOM, it is in the slot the configuration chose,
 * its value changes between two samples, and its native tooltip carries the measured ceiling,
 * heap, PID and uptime. It also saves a screenshot per run.
 *
 * Usage (no absolute path is baked in; every path is an argument or an environment variable):
 *   node scripts/e2e.mjs --cli <dsh-desktop-host/lib/cli.js> --node <node.exe> --home <DSH_HOME> \
 *     --profile ramtest --profile-dir <DSH_HOME/profiles/ramtest> --edge <msedge.exe> --out <dir> \
 *     [--placement floating] [--max-old-space 16384]
 *
 * `--profile-dir` is where the run writes its temporary placement override (a profile patch row);
 * the original file is restored when the run ends.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const key = token.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`)
    options[key] = value
    index += 1
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
for (const required of ['cli', 'node', 'home', 'profile', 'edge', 'out']) {
  if (!options[required]) {
    console.error(`e2e: --${required} is required`)
    process.exit(2)
  }
}
const placement = options.placement ?? 'sidebar-footer'
const maxOldSpace = options['max-old-space'] ?? ''
const outDir = options.out

function log(message) {
  console.log(`e2e: ${message}`)
}

/** Boot the host for one profile and resolve with its authenticated page URL. */
function startHost() {
  const args = []
  if (maxOldSpace) args.push(`--max-old-space-size=${maxOldSpace}`)
  args.push('--expose-internals', options.cli, '--profile', options.profile, '--no-open', '--port', '0')
  let patchBackup
  if (options['profile-dir']) {
    const patchPath = join(options['profile-dir'], 'cordis.patch.yml')
    patchBackup = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
    writeFileSync(patchPath, [
      '# Temporary e2e override, restored by scripts/e2e.mjs.',
      '- id: ram-meter',
      "  name: '@npmghost/dsh-ram-meter'",
      '  config:',
      `    placement: ${placement}`,
      // A fresh profile selects no model, and the composer refuses to submit without one; the
      // composer-dock run needs a real message to open a conversation.
      ...(placement === 'composer-dock'
        ? [
            '- id: agent-default-model',
            "  name: '@deepseek-ai/dsh-agent-default-model'",
            '  config:',
            '    provider: deepseek-account',
            '    model: deepseek-flash',
          ]
        : []),
      '',
    ].join('\n'))
  }
  const child = spawn(options.node, args, {
    env: { ...process.env, DSH_HOME: options.home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const output = []
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host printed no URL within 180 s:\n${output.join('')}`)), 180_000)
    const onChunk = (chunk) => {
      const text = String(chunk)
      output.push(text)
      const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"']+)/.exec(text)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`host exited with code ${code}:\n${output.join('')}`))
    })
  })
  return {
    child,
    url,
    output,
    restorePatch() {
      if (!options['profile-dir'] || patchBackup === undefined) return
      writeFileSync(join(options['profile-dir'], 'cordis.patch.yml'), patchBackup)
    },
  }
}

/** Start headless Edge and return its DevTools HTTP endpoint. */
async function startEdge(userDataDir) {
  const child = spawn(options.edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  const portFile = join(userDataDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').split('\n')
      if (port) return { child, port: Number(port) }
    }
    await delay(200)
  }
  child.kill()
  throw new Error('Edge did not expose a DevTools port')
}

/** Minimal CDP client over the page's WebSocket. */
function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  const pending = new Map()
  const listeners = new Map()
  let nextId = 1
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event.message ?? 'unknown'}`)))
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined) {
      for (const listener of listeners.get(message.method) ?? []) {
        try {
          listener(message.params)
        } catch {}
      }
      return
    }
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`))
    else entry.resolve(message.result)
  })
  return {
    async send(method, params = {}) {
      await ready
      const id = nextId
      nextId += 1
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    /** Subscribe to one CDP event method. */
    on(method, listener) {
      const list = listeners.get(method) ?? []
      list.push(listener)
      listeners.set(method, list)
    },
    close() {
      socket.close()
    },
  }
}

/** Evaluate an expression in the page and return its JSON value. */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`page evaluation failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
  }
  return result.result.value
}

/** Poll an expression until it returns a truthy value. */
async function waitFor(label, read, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (predicate(last)) return last
    await delay(500)
  }
  throw new Error(`${label} did not satisfy the expectation within ${timeoutMs} ms; last value: ${JSON.stringify(last)}`)
}

const PILL_QUERY = "document.querySelector('[data-dsh-ram-meter]')"

async function main() {
  await mkdir(outDir, { recursive: true })
  const host = startHost()
  let edge
  let cdp
  const evidence = { placement, maxOldSpace: maxOldSpace || 'default', steps: [] }

  try {
    const pageUrl = await host.url
    log(`host page ${pageUrl.replace(/token=[^&]+/, 'token=<redacted>')}`)

    const hostPort = Number(/127\.0\.0\.1:(\d+)/.exec(pageUrl)[1])
    const ram = await fetch(`http://127.0.0.1:${hostPort}/dsh-ram`).then((response) => {
      if (!response.ok) throw new Error(`/dsh-ram answered ${response.status}`)
      return response.json()
    })
    evidence.route = ram
    log(`route heapLimit ${ram.heapLimit} bytes (${(ram.heapLimit / 1024 ** 3).toFixed(2)} GiB), rss ${ram.rss}, pid ${ram.pid}`)

    // A fresh browser profile per run: a stale DevToolsActivePort from an earlier run would point
    // at a port nothing listens on.
    const userDataDir = join(outDir, `edge-profile-${placement}-${Date.now()}`)
    edge = await startEdge(userDataDir)

    const target = await fetch(`http://127.0.0.1:${edge.port}/json/new?${encodeURIComponent(pageUrl)}`, { method: 'PUT' })
      .then((response) => response.json())
    cdp = connectCdp(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    const statsReads = []
    cdp.on('Network.requestWillBeSent', (params) => {
      if (String(params?.request?.url ?? '').includes('/dsh-ram')) statsReads.push(params.request.url)
    })

    // `conversation.composer.dock` is a session-scoped slot: the composer only renders it once a
    // conversation exists, so open one before looking for the pill. A fresh profile has no
    // workspace session yet, so try the New-session controls and then a real submit.
    if (placement === 'composer-dock') {
      const dockMounted = async () => evaluate(cdp, `Boolean(document.querySelector('[data-composer-dock] [data-slot="conversation.composer.dock"]'))`)
      await waitFor('app shell', async () => evaluate(cdp, `Boolean(document.querySelector('textarea, [contenteditable="true"]'))`), Boolean, 90_000)
      const pressButton = async (pattern) => evaluate(cdp, `(() => {
        const button = [...document.querySelectorAll('button')].find((candidate) => ${pattern}.test(candidate.getAttribute('aria-label') ?? ''))
        if (button === undefined) return false
        button.click()
        return true
      })()`)
      for (const pattern of [/new session in/i, /^new session$/i, /^new session$/i]) {
        if (await pressButton(pattern)) {
          await delay(1500)
          if (await dockMounted()) break
        }
      }
      if (!(await dockMounted())) {
        const focused = await evaluate(cdp, `(() => {
          const input = document.querySelector('textarea') ?? document.querySelector('[contenteditable="true"]')
          if (input === null) return false
          input.focus()
          return true
        })()`)
        if (!focused) throw new Error('no composer input to open a conversation with')
        await cdp.send('Input.insertText', { text: 'hello' })
        for (const type of ['keyDown', 'keyUp']) {
          await cdp.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          })
        }
        log('submitted a message to open a conversation')
      }
      await waitFor('composer dock slot', dockMounted, Boolean, 45_000)
      log('composer dock slot mounted')
    }

    const info = await waitFor('pill', async () => evaluate(cdp, `(() => {
      const pill = ${PILL_QUERY}
      if (pill === null) return null
      return {
        placement: pill.dataset.ramPlacement,
        state: pill.dataset.ramState,
        rss: pill.dataset.ramRss,
        pct: pill.dataset.ramPct,
        tone: pill.dataset.ramTone,
        text: pill.textContent,
        title: pill.getAttribute('title'),
        ariaLabel: pill.getAttribute('aria-label'),
        position: getComputedStyle(pill).position,
        parentSlot: pill.closest('[data-slot]')?.getAttribute('data-slot') ?? null,
        slotSeat: pill.parentElement?.getAttribute('data-slot') ?? null,
      }
    })()`), (value) => value !== null && value.state === 'ok')
    evidence.pill = info
    log(`pill rendered: ${JSON.stringify(info.text)} (${info.placement}, ${info.tone})`)

    if (info.placement !== placement) throw new Error(`pill rendered in ${info.placement}, expected ${placement}`)
    // The visible text is a row of spans spaced by flex `gap`, so textContent has no spaces; the
    // accessible label is the same sentence with its spacing intact.
    const compactText = String(info.text).replace(/\s+/g, '')
    if (!/^RAM\d+\.\d{2}GB·\d+%(\d+GB)?$/.test(compactText)) {
      throw new Error(`unexpected pill text: ${JSON.stringify(info.text)}`)
    }
    if (!/^RAM \d+\.\d{2} GB · \d+%$/.test(String(info.ariaLabel))) {
      throw new Error(`unexpected accessible label: ${JSON.stringify(info.ariaLabel)}`)
    }
    for (const needle of ['ceiling', 'Heap', 'PID', 'uptime']) {
      if (!String(info.title).includes(needle)) throw new Error(`tooltip is missing ${needle}: ${JSON.stringify(info.title)}`)
    }
    const ceilingGb = Math.round(ram.heapLimit / 1024 ** 3)
    if (!String(info.title).includes(`${ceilingGb} GB`)) {
      throw new Error(`tooltip does not name the measured ${ceilingGb} GB ceiling: ${JSON.stringify(info.title)}`)
    }
    evidence.steps.push({ name: 'pill present in configured slot', ok: true })
    evidence.steps.push({ name: 'tooltip carries ceiling, heap, pid, uptime', ok: true })

    if (placement === 'floating' && info.position !== 'fixed') {
      throw new Error(`floating placement is not fixed-positioned: ${info.position}`)
    }

    const first = await evaluate(cdp, `(() => { const pill = ${PILL_QUERY}; return pill?.dataset.ramRss ?? '' })()`)
    const second = await waitFor('changing value', async () => evaluate(cdp, `(() => {
      const pill = ${PILL_QUERY}
      return pill?.dataset.ramRss ?? ''
    })()`), (value) => value !== '' && value !== first, 25_000)
    evidence.samples = { first, second }
    log(`rss changed between samples: ${first} -> ${second}`)
    evidence.steps.push({ name: 'value changes between two samples', ok: true })

    // Regression check for the tooltip flicker: while the pointer rests on the pill the poll must
    // stop, so neither the displayed value nor the `title` text may change, and no /dsh-ram request
    // may happen. Leaving must restart the poll without a reload.
    const mouseTo = async (point) => cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
    })
    const readPill = () => evaluate(cdp, `(() => {
      const pill = ${PILL_QUERY}
      if (pill === null) return null
      return { rss: pill.dataset.ramRss, title: pill.getAttribute('title'), text: pill.textContent }
    })()`)
    const pillCentre = await evaluate(cdp, `(() => {
      const rect = ${PILL_QUERY}.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    const away = { x: 4, y: 4 }

    // A first-run modal (the preview notice) owns a full-window backdrop, so the pointer never
    // reaches the pill under it. Dismiss it before the hover check.
    const dismissed = await evaluate(cdp, `(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => /^(continue|got it|ok|dismiss)$/i.test((candidate.textContent ?? '').trim()))
      if (button === undefined) return false
      button.click()
      return true
    })()`)
    if (dismissed) {
      log('dismissed the first-run notice')
      await delay(700)
    }
    // Some first-run surfaces also close on Escape; harmless when nothing is open.
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    }
    await delay(400)

    await mouseTo(away)
    await delay(200)
    const readsBeforeHover = statsReads.length
    await mouseTo(pillCentre)
    await delay(400)
    const hoverProbe = await evaluate(cdp, `(() => {
      const pill = ${PILL_QUERY}
      const rect = pill.getBoundingClientRect()
      const atPoint = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        hovered: pill.matches(':hover'),
        reachedPill: atPoint !== null && atPoint.closest('[data-dsh-ram-meter]') !== null,
        atPoint: atPoint === null ? null : atPoint.tagName + '.' + String(atPoint.className).slice(0, 60),
        masks: [...document.querySelectorAll('[class*="_mask_"]')].map((element) => {
          const rect = element.getBoundingClientRect()
          return {
            cls: String(element.className).slice(0, 40),
            box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
            pointerEvents: getComputedStyle(element).pointerEvents,
          }
        }),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((element) => (element.textContent ?? '').slice(0, 40)),
      }
    })()`)
    evidence.hoverProbe = hoverProbe
    if (!hoverProbe.hovered) throw new Error(`pointer never entered the pill: ${JSON.stringify(hoverProbe)}`)
    const hoverStart = await readPill()
    const hoverSamples = []
    for (let index = 0; index < 10; index += 1) {
      await delay(500)
      hoverSamples.push(await readPill())
    }
    const readsWhileHovering = statsReads.length - readsBeforeHover
    evidence.hover = { start: hoverStart, samples: hoverSamples, statsReadsWhileHovering: readsWhileHovering }

    for (const [index, hoverSample] of hoverSamples.entries()) {
      if (hoverSample === null) throw new Error(`pill disappeared while hovering (sample ${index})`)
      if (hoverSample.title !== hoverStart.title) {
        throw new Error(`tooltip text changed while hovering: ${JSON.stringify({ from: hoverStart.title, to: hoverSample.title })}`)
      }
      if (hoverSample.rss !== hoverStart.rss) {
        throw new Error(`displayed value changed while hovering: ${hoverStart.rss} -> ${hoverSample.rss}`)
      }
      if (hoverSample.text !== hoverStart.text) throw new Error('pill text changed while hovering')
    }
    if (readsWhileHovering !== 0) throw new Error(`polling continued while hovering (${readsWhileHovering} /dsh-ram reads)`)
    evidence.steps.push({ name: 'tooltip and value frozen for 5 s of hover, no polling', ok: true })
    log(`hover: ${hoverSamples.length} samples over 5 s identical, ${readsWhileHovering} polls`)

    await mouseTo(away)
    const readsBeforeLeave = statsReads.length
    await waitFor('resumed polling', async () => statsReads.length, (count) => count > readsBeforeLeave, 15_000)
    const resumed = await readPill()
    evidence.hover.resumedRss = resumed?.rss ?? ''
    evidence.steps.push({ name: 'polling resumes after the pointer leaves', ok: true })
    log(`hover ended: polling resumed (${statsReads.length - readsBeforeLeave} reads), value ${resumed?.rss}`)

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const screenshotPath = join(outDir, `pill-${placement}.png`)
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
    evidence.screenshot = screenshotPath
    log(`screenshot ${screenshotPath}`)

    evidence.ok = true
  } catch (error) {
    evidence.ok = false
    evidence.error = String(error?.stack ?? error)
    evidence.hostLog = host.output.join('').slice(-4000)
    if (cdp !== undefined) {
      try {
        evidence.diagnostics = await evaluate(cdp, `(() => ({
          url: location.href,
          slots: [...document.querySelectorAll('[data-slot]')].map((element) => element.getAttribute('data-slot')),
          hasComposer: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
          composerDock: Boolean(document.querySelector('[data-composer-dock]')),
          buttons: [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')).filter(Boolean).slice(0, 40),
          bodyText: document.body.innerText.slice(0, 600),
          pillSlots: [...document.querySelectorAll('[data-dsh-ram-meter]')].map((element) => element.dataset.ramPlacement),
        }))()`)
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(join(outDir, `failure-${placement}.png`), Buffer.from(screenshot.data, 'base64'))
      } catch {}
    }
    throw error
  } finally {
    writeFileSync(join(outDir, `e2e-${placement}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
    try {
      cdp?.close()
    } catch {}
    edge?.child?.kill()
    host.child.kill()
    await delay(1500)
    if (host.child.exitCode === null) host.child.kill('SIGKILL')
    host.restorePatch()
  }
}

main().then(() => {
  log('all assertions passed')
  process.exit(0)
}).catch((error) => {
  console.error(`e2e: FAILED ${error?.message ?? error}`)
  process.exit(1)
})
