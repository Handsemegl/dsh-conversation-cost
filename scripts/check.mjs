/**
 * Offline checks for dsh-conversation-cost.
 *
 * 1. Host: mount apply() against fakes and drive the HTTP route handler with a
 *    synthetic session log, asserting the folded token totals and the CNY cost
 *    for both peak and off-peak timestamps.
 * 2. Client: evaluate the module-loader bundle with a stub React, run apply(),
 *    and confirm both slot registrations and that the components render.
 *
 * Run with: node scripts/check.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)

/* ---------------------------------- host --------------------------------- */

function fakeSession(events) {
  return {
    snapshotEvents(fromSeq) {
      return events.filter((event) => event.seq >= fromSeq)
    },
  }
}

function mountHost(getSession, options = {}) {
  const disposers = []
  const events = new Map()
  const ctx = {
    sessions: { get: getSession },
    webServer: {
      register(candidate) {
        routes.set(candidate.path, candidate)
        return () => {
          routes.delete(candidate.path)
        }
      },
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    on(name, listener) {
      events.set(name, listener)
      return () => {}
    },
    get(name) {
      return name === 'llm' ? options.llm : undefined
    },
  }
  host.apply(ctx, options.config)
  assert.ok(routes.has('/api/dsh-conversation-cost/session'), 'the host half must register a route')
  assert.ok(routes.has('/api/dsh-conversation-cost/pricing'), 'the pricing route must be registered')
  return { events, disposeAll: () => disposers.forEach((dispose) => dispose()) }
}

const routes = new Map()
const SESSION_ROUTE = () => routes.get('/api/dsh-conversation-cost/session')
const PRICING_ROUTE = () => routes.get('/api/dsh-conversation-cost/pricing')

function call(route, url, method = 'GET') {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:14484' },
      socket: { remoteAddress: '127.0.0.1' },
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status
      },
      end(body) {
        this.body = body
        resolve(this)
      },
    }
    route.handler(req, res)
  })
}

const OFF_PEAK = Date.UTC(2026, 10, 21, 2, 0, 0) // Saturday
const PEAK = Date.UTC(2026, 10, 24, 2, 0, 0) // Tuesday 10:00 Beijing

function logWith(time) {
  return [
    { seq: 0, type: 'session', time, data: {} },
    {
      seq: 1,
      type: 'assistant/message',
      time,
      data: {
        message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
        usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 600000 },
      },
    },
  ]
}

const sessions = new Map()
const hostApp = mountHost((id) => sessions.get(id))
await new Promise((resolve) => setTimeout(resolve, 10))

sessions.set('s-off', fakeSession(logWith(OFF_PEAK)))
const offPeak = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-off')).body)
assert.equal(offPeak.ok, true)
assert.equal(offPeak.currency, 'CNY')
assert.equal(offPeak.requests, 1)
assert.equal(offPeak.cacheHitTokens, 600000)
assert.equal(offPeak.cacheMissTokens, 400000)
assert.equal(offPeak.outputTokens, 1000000)
assert.ok(Math.abs(offPeak.totalCost - 4.412) < 1e-9, `off-peak cost ${offPeak.totalCost} != 4.412`)
assert.equal(offPeak.models[0].pricingModel, 'deepseek-flash')
assert.equal(offPeak.models[0].peakRequests, 0)

sessions.set('s-peak', fakeSession(logWith(PEAK)))
const peak = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-peak')).body)
assert.ok(Math.abs(peak.totalCost - 8.824) < 1e-9, `peak cost ${peak.totalCost} != 8.824`)
assert.equal(peak.peakRequests, 1)

// A second read must not double count.
const again = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-peak')).body)
assert.ok(Math.abs(again.totalCost - 8.824) < 1e-9, 'incremental fold must be idempotent')

// Per-turn buckets: usage is grouped by the logged turn, with its seq range.
function twoTurnLog() {
  return [
    { seq: 0, type: 'turn/start', time: OFF_PEAK, data: { turn: 1 } },
    {
      seq: 1,
      type: 'assistant/message',
      time: OFF_PEAK,
      data: {
        turn: 1,
        message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
        usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 600000 },
      },
    },
    { seq: 2, type: 'turn/end', time: OFF_PEAK, data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 3, type: 'turn/start', time: PEAK, data: { turn: 2 } },
    {
      seq: 4,
      type: 'assistant/message',
      time: PEAK,
      data: {
        turn: 2,
        message: { source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' } },
        usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 600000 },
      },
    },
    { seq: 5, type: 'turn/end', time: PEAK, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

sessions.set('s-turns', fakeSession(twoTurnLog()))
const turns = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-turns')).body)
assert.equal(turns.turns.length, 2, 'two turns must be reported')
assert.equal(turns.turns[0].turn, 1)
assert.equal(turns.turns[0].startSeq, 0)
assert.equal(turns.turns[0].endSeq, 2)
assert.ok(Math.abs(turns.turns[0].cost - 4.412) < 1e-9, `turn 1 cost ${turns.turns[0].cost} != 4.412`)
assert.equal(turns.turns[0].peakRequests, 0)
assert.equal(turns.turns[1].turn, 2)
assert.equal(turns.turns[1].startSeq, 3)
assert.equal(turns.turns[1].endSeq, 5)
assert.ok(Math.abs(turns.turns[1].cost - 8.824) < 1e-9, `turn 2 cost ${turns.turns[1].cost} != 8.824`)
assert.equal(turns.turns[1].peakRequests, 1)
assert.ok(
  Math.abs(turns.turns[0].cost + turns.turns[1].cost - turns.totalCost) < 1e-9,
  'per-turn costs must add up to the session total'
)

// Unknown models fall back to the Flash rate and are flagged.
sessions.set(
  's-unknown',
  fakeSession([
    {
      seq: 1,
      type: 'assistant/message',
      time: OFF_PEAK,
      data: {
        message: { source: { kind: 'model', provider: 'other', model: 'mystery-1' } },
        usage: { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0 },
      },
    },
  ])
)
const unknown = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-unknown')).body)
assert.equal(unknown.models[0].fallback, true)
assert.ok(Math.abs(unknown.totalCost - 1) < 1e-9)

// A missing session answers 404 not-live; a bad request answers 400.
const missing = await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=nope')
assert.equal(missing.status, 404)
assert.equal(JSON.parse(missing.body).reason, 'not-live')
const malformed = await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session')
assert.equal(malformed.status, 400)
const forbidden = await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=s-peak')
assert.equal(forbidden.status, 200, 'a loopback request must pass the origin guard')

hostApp.disposeAll()

/* --------------------- automatic model matching --------------------------- */

function usageLog(model, costIn = 1000000, costOut = 0, cacheRead = 0) {
  return [
    { seq: 0, type: 'turn/start', time: OFF_PEAK, data: { turn: 1 } },
    {
      seq: 1,
      type: 'assistant/message',
      time: OFF_PEAK,
      data: {
        turn: 1,
        message: { source: { kind: 'model', provider: 'deepseek', model } },
        usage: { inputTokens: costIn, outputTokens: costOut, cacheReadTokens: cacheRead },
      },
    },
  ]
}

const MODEL_SESSIONS = new Map()
const llm = {
  listProviders: () => [{ id: 'deepseek' }, { id: 'other' }],
  listModels: async (provider) =>
    provider === 'deepseek'
      ? [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }]
      : [{ id: 'gpt-4o' }],
}

const matching = mountHost((id) => MODEL_SESSIONS.get(id), { llm })
await new Promise((resolve) => setTimeout(resolve, 10))

async function modelOf(id, model, config) {
  // Fresh Session object and sessionId per probe: the accumulator is keyed by
  // object identity and lives in the module (shared across test mounts).
  const sessionId = id + ':' + model + ':' + (config === undefined ? 'no-config' : 'config:' + Object.keys(config.pricing ?? {}).join(','))
  MODEL_SESSIONS.set(sessionId, fakeSession(usageLog(model)))
  let body
  if (config === undefined) {
    body = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=' + encodeURIComponent(sessionId))).body)
  } else {
    const mounted = mountHost((key) => MODEL_SESSIONS.get(key), { llm, config })
    await new Promise((resolve) => setTimeout(resolve, 10))
    body = JSON.parse((await call(SESSION_ROUTE(), '/api/dsh-conversation-cost/session?sessionId=' + encodeURIComponent(sessionId))).body)
    mounted.disposeAll()
  }
  assert.equal(body.ok, true, 'probe must succeed: ' + body.reason)
  return body.models[0]
}

// 1. Exact official id.
const flash = await modelOf('m1', 'deepseek-flash')
assert.equal(flash.match, 'exact')
assert.equal(flash.fallback, false)
assert.equal(flash.rateSource, 'official')

// 2. Runtime alias: still accepted by the API, billed at the Flash row.
const alias = await modelOf('m2', 'deepseek-v4-flash')
assert.equal(alias.match, 'alias')
assert.equal(alias.pricingModel, 'deepseek-flash')
assert.equal(alias.fallback, false)

// 3. Retired DeepSeek id: served by Flash, billed at the Flash rate.
const retired = await modelOf('m3', 'deepseek-chat')
assert.equal(retired.match, 'retired')
assert.equal(retired.pricingModel, 'deepseek-flash')

// 4. A model the runtime really serves but the table has no row for.
const other = await modelOf('m4', 'gpt-4o')
assert.equal(other.match, 'catalog', 'a catalog id must be recognized')
assert.equal(other.rateSource, 'fallback')
assert.equal(other.fallback, true, 'without an official row it still shows as an estimate')

// 5. A model nobody knows keeps the plain fallback.
const mystery = await modelOf('m5', 'mystery-2')
assert.equal(mystery.match, 'fallback')
assert.equal(mystery.fallback, true)

// 6. An explicit override pins the price of a non-official model: the model is
//    still recognized as unknown in `match`, but its rate is no longer an estimate.
//    Probes run at OFF_PEAK, so the configured peak rate is halved.
const overridden = await modelOf('m6', 'mystery-2', { pricing: { 'mystery-2': { cacheHit: 0.1, cacheMiss: 5, output: 10 } } })
assert.equal(overridden.match, 'fallback')
assert.equal(overridden.fallback, false, 'a configured rate is no longer an estimate')
assert.ok(Math.abs(overridden.cost - 2.5) < 1e-9, `overridden off-peak cost ${overridden.cost} != 2.5`)

// 6b. A model the runtime serves but whose rate nobody configured stays an estimate.
const catalogOnly = await modelOf('m6b', 'gpt-4o', { pricing: { 'mystery-2': { cacheHit: 0.1, cacheMiss: 5, output: 10 } } })
assert.equal(catalogOnly.match, 'catalog')
assert.equal(catalogOnly.fallback, true, 'a catalog model without a rate stays an estimate')

// 6c. Configuring the fallback family prices unknown models on purpose.
const forcedFallback = await modelOf('m6c', 'mystery-2', {
  pricing: { 'deepseek-flash': { cacheHit: 0.1, cacheMiss: 5, output: 10 } },
})
assert.ok(Math.abs(forcedFallback.cost - 2.5) < 1e-9, `fallback-family override cost ${forcedFallback.cost} != 2.5`)

// 7. An override for a known row applies to that row (also off-peak half price).
const proOverride = await modelOf('m7', 'deepseek-v4-pro', { pricing: { 'deepseek-v4-pro': { cacheHit: 0, cacheMiss: 1, output: 1 } } })
assert.ok(Math.abs(proOverride.cost - 0.5) < 1e-9, `override cost ${proOverride.cost} != 0.5`)
assert.equal(proOverride.pricingModel, 'deepseek-v4-pro')
assert.equal(proOverride.fallback, false)

// The pricing route reports the table, the overrides and the live catalog.
// Mounted last, so every earlier probe route has been disposed.
const pricingHost = mountHost((id) => MODEL_SESSIONS.get(id), {
  llm,
  config: { pricing: { 'deepseek-v4-pro': { cacheHit: 0, cacheMiss: 1, output: 1 } } },
})
await new Promise((resolve) => setTimeout(resolve, 10))
const pricing = JSON.parse((await call(PRICING_ROUTE(), '/api/dsh-conversation-cost/pricing')).body)
assert.equal(pricing.ok, true)
assert.ok(pricing.rows['deepseek-flash'])
assert.deepEqual(pricing.overrides, ['deepseek-v4-pro'])
assert.deepEqual(pricing.catalog.sort(), ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o'])
pricingHost.disposeAll()

matching.disposeAll()

/* --------------------------------- client -------------------------------- */

const registered = []
let styleTags = 0

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
}

const sandbox = {
  console,
  document: {
    visibilityState: 'visible',
    head: { appendChild() {} },
    createElement() {
      return { setAttribute() {}, textContent: '' }
    },
    querySelector() {
      return null
    },
    addEventListener() {},
    removeEventListener() {},
  },
  window: {
    setInterval() {
      return 0
    },
    clearInterval() {},
    __ModuleLoader__: {
      load(definition) {
        registered.push(definition)
      },
    },
  },
  Set,
  Object,
  Array,
  String,
  Number,
  Math,
  Date,
  JSON,
  isFinite,
  encodeURIComponent,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, totalCost: 0, models: [] }) }),
}
sandbox.window.window = sandbox.window

vm.runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox, { filename: 'client.js' })

assert.equal(registered.length, 1, 'the client bundle must register exactly one factory')
assert.equal(registered[0].id, 'dsh-conversation-cost')

const slots = []
const localeCalls = []
const ctx = {
  slots: {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      slots.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register(ns, dicts) {
      localeCalls.push({ ns, dicts })
      return () => {}
    },
    bind() {
      return (key) => key
    },
    subscribe() {
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return dispose
  },
}

const client = registered[0].factory((id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
})
client.apply(ctx)

assert.equal(slots.length, 3, 'three slot entries are expected')
assert.deepEqual(
  slots.map((entry) => [entry.options.name, entry.options.id]),
  [
    ['conversation.composer.dock', 'cost'],
    ['conversation.input.dock', 'cost-detail'],
    ['conversation.chat.turnTail', 'cost'],
  ]
)
assert.equal(slots[0].options.order, 2)
assert.equal(slots[2].options.order, 30)
assert.equal(localeCalls.length, 1)
assert.equal(localeCalls[0].ns, 'conversation-cost')
assert.ok(localeCalls[0].dicts.zh.panelTitle)

// Render both components through the stub React.
for (const entry of slots) {
  const tree = entry.component({ sessionId: 's-peak', seq: 5 })
  assert.ok(tree === null || typeof tree === 'object', 'component must return a node')
}

/* ------------------------- per-turn seq resolution ------------------------ */

const { turnEntryOf } = client.__internals
const payload = {
  turns: [
    { turn: 1, startSeq: 5, endSeq: 527, cost: 0.45, requests: 69 },
    { turn: 2, startSeq: 529, endSeq: 657, cost: 0.12, requests: 18 },
  ],
}

// Exact turn number from the owner's Turn location wins.
assert.equal(turnEntryOf(payload, 9999, { turn: 2 }).turn, 2)
assert.equal(turnEntryOf(payload, undefined, { turn: 1 }).turn, 1)
// A closing seq inside the Turn's span resolves it.
assert.equal(turnEntryOf(payload, 5, undefined).turn, 1)
assert.equal(turnEntryOf(payload, 300, undefined).turn, 1)
assert.equal(turnEntryOf(payload, 657, undefined).turn, 2)
// One past the span, and the newest completed Turn, still resolve.
assert.equal(turnEntryOf(payload, 528, undefined).turn, 1)
assert.equal(turnEntryOf(payload, 660, undefined).turn, 2)
// Nothing before the first Turn.
assert.equal(turnEntryOf(payload, 1, undefined), undefined)
assert.equal(turnEntryOf(undefined, 5, { turn: 1 }), undefined)

assert.equal(client.__internals.formatYuan(0.41844164), '0.418')
assert.equal(client.__internals.formatYuan(0.0042), '0.0042')
assert.equal(client.__internals.formatYuan(0), '0.00')
assert.equal(client.__internals.formatCount(141491), '141.5k')

console.log('host + client checks passed')
