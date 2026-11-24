/**
 * dsh-conversation-cost — Host half (plain JavaScript, zero external deps).
 *
 * Registers one read-only route:
 *   GET /api/dsh-conversation-cost/session?sessionId=<id>
 *
 * The payload is the accumulated cost of that conversation in CNY, computed from
 * the provider `usage` reported on every settled `assistant/message` event, priced
 * with the official DeepSeek RMB table (peak / off-peak, per million tokens).
 *
 * Contract notes:
 *   - Usage is provider-reported, so the figure is a real cost, not a token guess.
 *   - The model id is matched automatically against the price table: an exact id
 *     first, then the runtime model catalog (`llm.listModels`), then an alias map,
 *     then a family/era rule, and finally the configured fallback rate. Every
 *     matched model reports HOW it matched (`match`) and who supplies its price
 *     (`rateSource`), so an estimate is never disguised as a known price.
 *   - Only live sessions are served (`ctx.sessions.get`); an unknown or closed
 *     session answers 404 `not-live`, and the UI then shows a dash.
 *   - Folding is incremental per live Session object, so polling stays cheap.
 *   - Every event's bucket is kept for a while, so a later price edit restates the
 *     existing totals instead of only affecting future usage.
 *   - Subagent children run in their own sessions. Their spend is merged into the
 *     reported total (and listed per child), so the number matches what the
 *     conversation really cost. User forks are NOT merged: they are independent
 *     conversations that merely share a parent.
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Stable Cordis plugin name. */
export const name = 'conversation-cost'

/** Services required: the HTTP carrier and the in-memory Session store. */
export const inject = ['webServer', 'sessions']

/** Optional service used to recognize the models this runtime actually serves. */
export const optional = ['llm']

/** Route prefix. */
const API_PREFIX = '/api/dsh-conversation-cost'

/** Bumped whenever the price table below changes. */
const PRICING_VERSION = 'deepseek-2026-11'

/**
 * Official DeepSeek list prices, CNY per 1M tokens.
 * Source: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * Peak hours are Beijing time (UTC+8) Monday-Friday 09:00-12:00 and 14:00-18:00,
 * excluding Chinese public holidays; every other hour is off-peak (half price).
 */
const PRICING = {
  'deepseek-flash': {
    model: 'deepseek-flash',
    label: 'DeepSeek Flash',
    cacheHit: { peak: 0.04, offPeak: 0.02 },
    cacheMiss: { peak: 2, offPeak: 1 },
    output: { peak: 8, offPeak: 4 },
  },
  'deepseek-v4-pro': {
    model: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    cacheHit: { peak: 0.3, offPeak: 0.15 },
    cacheMiss: { peak: 9, offPeak: 4.5 },
    output: { peak: 27, offPeak: 13.5 },
  },
}

/** Rate used by every model without its own official row. */
const FALLBACK_KEY = 'deepseek-flash'

/** Runtime aliases: model ids the API still accepts, billed at another row. */
const RUNTIME_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/**
 * Retired DeepSeek ids whose requests are served by the current Flash model and
 * billed at the Flash rate.
 */
const RETIRED_DEEPSEEK = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'deepseek-v3', 'deepseek-v3.1', 'deepseek-v3.2']

/** Milliseconds of the Beijing-time offset; China has no DST. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Peak windows as minutes since Beijing midnight. */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** How many priced events one accumulator keeps for repricing. */
const EVENT_CAP = 50000

/** How long one provider's catalog read may take before the refresh moves on. */
const CATALOG_TIMEOUT_MS = 4000

/** One fold accumulator per live Session object. */
const fallbacks = new WeakMap()

/**
 * Whether one event timestamp falls inside a Beijing-time weekday peak window.
 * Chinese public holidays are not modelled; they count as off-peak in reality.
 * @param time - event epoch milliseconds
 * @returns whether peak pricing applies
 */
function isPeakTime(time) {
  const shifted = new Date(time + BEIJING_OFFSET_MS)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  for (const [start, end] of PEAK_WINDOWS) {
    if (minutes >= start && minutes < end) return true
  }
  return false
}

/**
 * Resolve the price row for a provider model id by static rules only.
 * Used before the runtime model catalog is known (and inside repricing).
 * @param model - the recorded model id
 * @returns the price attributes for that id
 */
function resolvePricingStatic(model) {
  const raw = String(model ?? 'unknown')
  const id = raw.toLowerCase()

  const exact = PRICING[id]
  if (exact !== undefined) {
    return { pricingModel: exact.model, pricingLabel: exact.label, exactRate: true, match: 'exact', rateSource: 'official', aliasOf: null }
  }
  const alias = RUNTIME_ALIASES[id]
  if (alias !== undefined) {
    const row = PRICING[alias]
    return {
      pricingModel: row.model,
      pricingLabel: row.label,
      exactRate: true,
      match: 'alias',
      rateSource: 'official',
      aliasOf: alias,
    }
  }
  const fallback = PRICING[FALLBACK_KEY]
  if (RETIRED_DEEPSEEK.includes(id) || /^deepseek-(chat|reasoner|coder|v[0-9])/.test(id)) {
    return {
      pricingModel: fallback.model,
      pricingLabel: fallback.label,
      exactRate: false,
      match: 'retired',
      rateSource: 'official',
      aliasOf: FALLBACK_KEY,
    }
  }
  if (/flash/.test(id)) {
    return {
      pricingModel: fallback.model,
      pricingLabel: fallback.label,
      exactRate: false,
      match: 'heuristic',
      rateSource: 'heuristic',
      aliasOf: FALLBACK_KEY,
    }
  }
  if (/pro/.test(id)) {
    const pro = PRICING['deepseek-v4-pro']
    return {
      pricingModel: pro.model,
      pricingLabel: pro.label,
      exactRate: false,
      match: 'heuristic',
      rateSource: 'heuristic',
      aliasOf: 'deepseek-v4-pro',
    }
  }
  return {
    pricingModel: fallback.model,
    pricingLabel: fallback.label,
    exactRate: false,
    match: 'fallback',
    rateSource: 'fallback',
    aliasOf: null,
  }
}

/**
 * Resolve a model id against the static rules AND the runtime model catalog.
 * A catalog hit means the provider really serves this id; the price row is still
 * chosen by the static rules, but the match is reported as `catalog`.
 * @param model - the recorded model id
 * @param catalog - lowercased model ids the runtime advertises, or null
 * @returns the price attributes for that id
 */
function resolveModel(model, catalog) {
  const raw = String(model ?? 'unknown')
  const base = resolvePricingStatic(raw)
  if (base.match === 'exact' || base.match === 'alias') return base
  if (catalog !== null && catalog.has(raw.toLowerCase())) {
    return { ...base, match: 'catalog' }
  }
  return base
}

/** Whether a pricing resolution can be trusted without an estimate marker. */
function isExactRate(attrs) {
  if (attrs.override !== undefined) return true
  return attrs.match === 'exact' || attrs.match === 'alias' || (attrs.match === 'catalog' && attrs.rateSource === 'official')
}

/** Create the empty accumulator for one Session. */
function createAccumulator() {
  return {
    lastSeq: -1,
    requests: 0,
    peakRequests: 0,
    offPeakRequests: 0,
    inputTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    firstTime: undefined,
    lastTime: undefined,
    models: new Map(),
    turns: new Map(),
    events: [],
    repriced: false,
  }
}

/**
 * Look up (or create) the accumulator bucket for one turn.
 * @param acc - the Session accumulator
 * @param turn - the turn number
 * @param seq - the seq of the event that touched this turn
 * @param startsTurn - whether this event opens the turn
 * @returns the turn bucket
 */
function ensureTurn(acc, turn, seq, startsTurn) {
  const key = String(turn)
  let bucket = acc.turns.get(key)
  if (bucket === undefined) {
    bucket = {
      turn,
      firstSeq: seq,
      lastSeq: seq,
      startSeq: startsTurn ? seq : undefined,
      endSeq: undefined,
      requests: 0,
      peakRequests: 0,
      offPeakRequests: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      cost: 0,
    }
    acc.turns.set(key, bucket)
    return bucket
  }
  if (startsTurn) bucket.startSeq = seq
  bucket.firstSeq = Math.min(bucket.firstSeq, seq)
  bucket.lastSeq = Math.max(bucket.lastSeq, seq)
  return bucket
}

/** One model bucket inside an accumulator. */
function modelBucket(acc, model, attrs) {
  let bucket = acc.models.get(model)
  if (bucket !== undefined) return bucket
  bucket = {
    model,
    pricingModel: attrs.pricingModel,
    pricingLabel: attrs.pricingLabel,
    fallback: !isExactRate(attrs),
    match: attrs.match,
    rateSource: attrs.rateSource,
    aliasOf: attrs.aliasOf,
    requests: 0,
    peakRequests: 0,
    offPeakRequests: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    cost: 0,
  }
  acc.models.set(model, bucket)
  return bucket
}

/** Cost of one request under one price row and band. */
function costOf(pricingModel, hit, miss, output, band) {
  const row = PRICING[pricingModel] ?? PRICING[FALLBACK_KEY]
  return (hit * row.cacheHit[band] + miss * row.cacheMiss[band] + output * row.output[band]) / 1e6
}

/**
 * Split one provider usage report into the three billed buckets.
 *
 * The buckets are NOT interchangeable across providers:
 *
 * - DeepSeek reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`
 *   separately, so `inputTokens` holds ONLY the uncached prompt and
 *   `cacheReadTokens` holds ONLY the cached prompt. Their `totalTokens` is the
 *   sum of all three buckets.
 * - An OpenAI-shaped report puts the whole prompt in `inputTokens` and repeats
 *   the cached part in `cacheReadTokens` (a subset), with `totalTokens` =
 *   input + output.
 *
 * `totalTokens` is the tell: if it equals input + output + cacheRead, the cached
 * tokens are a separate bucket; if it equals input + output, they are a subset.
 * Without a usable total, cached-exceeds-input can only happen in the disjoint
 * shape, and everything else falls back to the conservative subset reading.
 *
 * @param usage - the provider-reported usage record
 * @returns cached, uncached, output and prompt totals
 */
function decomposeUsage(usage) {
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  const cacheRead = Number(usage.cacheReadTokens)
  const hit = Number.isFinite(cacheRead) && cacheRead > 0 ? cacheRead : 0
  const total = Number(usage.totalTokens)
  const near = (candidate) => Number.isFinite(total) && Math.abs(candidate - total) <= Math.max(2, total * 0.001)

  if (near(input + output + hit)) {
    // Disjoint buckets: every cached token sits outside inputTokens.
    return { hit, miss: Math.max(0, input), output, prompt: Math.max(0, input) + hit }
  }
  if (near(input + output)) {
    // Subset buckets: cached tokens are already counted inside inputTokens.
    const miss = Math.max(0, input - hit)
    return { hit: Math.min(hit, input), miss, output, prompt: input }
  }
  if (hit > input) {
    return { hit, miss: Math.max(0, input), output, prompt: Math.max(0, input) + hit }
  }
  const miss = Math.max(0, input - hit)
  return { hit: Math.min(hit, input), miss, output, prompt: input }
}

/** Add one provider usage report at one timestamp to the Session and its turn. */
function recordUsage(acc, usage, model, time, turn, seq, catalog) {
  const split = decomposeUsage(usage)
  const { hit, miss, output, prompt } = split
  if (!Number.isFinite(miss) || !Number.isFinite(output)) return

  const modelId = String(model ?? 'unknown')
  const attrs = resolveModel(modelId, catalog)
  const peak = isPeakTime(time)
  const band = peak ? 'peak' : 'offPeak'
  const cost = costOf(attrs.pricingModel, hit, miss, output, band)

  const bucket = modelBucket(acc, modelId, attrs)
  bucket.requests += 1
  if (peak) bucket.peakRequests += 1
  else bucket.offPeakRequests += 1
  bucket.cacheHitTokens += hit
  bucket.cacheMissTokens += miss
  bucket.outputTokens += output
  bucket.cost += cost

  acc.requests += 1
  if (peak) acc.peakRequests += 1
  else acc.offPeakRequests += 1
  acc.inputTokens += prompt
  acc.cacheHitTokens += hit
  acc.cacheMissTokens += miss
  acc.outputTokens += output
  acc.totalCost += cost
  if (acc.firstTime === undefined) acc.firstTime = time
  acc.lastTime = time

  if (turn !== undefined && turn !== null) {
    const turnBucket = ensureTurn(acc, turn, seq, false)
    turnBucket.requests += 1
    if (peak) turnBucket.peakRequests += 1
    else turnBucket.offPeakRequests += 1
    turnBucket.cacheHitTokens += hit
    turnBucket.cacheMissTokens += miss
    turnBucket.outputTokens += output
    turnBucket.cost += cost
  }

  // Keep the priced inputs so a later catalog/price change can restate totals.
  if (acc.events.length < EVENT_CAP) {
    acc.events.push({ model: modelId, time, turn, decayed: false, prompt, hit, miss, output, cost })
  } else {
    markDecayed(acc, null)
  }
}

/**
 * Recompute every kept event under the current catalog plus any price overrides
 * from the runtime configuration.
 * @param acc - the accumulator to restate
 * @param catalog - lowercased runtime model ids, or null
 * @param overrides - extra price rows keyed by family/pricing slug
 */
function reprice(acc, catalog, overrides) {
  const extra = overrides !== null && overrides !== undefined ? overrides : {}
  const overrideOf = (modelId, attrs) => {
    const byPricing = extra[attrs.pricingModel]
    if (byPricing !== undefined) return byPricing
    if (attrs.aliasOf !== undefined && extra[attrs.aliasOf] !== undefined) return extra[attrs.aliasOf]
    return extra[attrs.match === 'fallback' ? FALLBACK_KEY : ''] ?? extra[modelId]
  }

  acc.requests = 0
  acc.peakRequests = 0
  acc.offPeakRequests = 0
  acc.inputTokens = 0
  acc.cacheHitTokens = 0
  acc.cacheMissTokens = 0
  acc.outputTokens = 0
  acc.totalCost = 0
  acc.firstTime = undefined
  acc.lastTime = undefined
  acc.models.clear()
  // Turn seq boundaries survive repricing; only the token/cost fields restart.
  for (const bucket of acc.turns.values()) {
    bucket.requests = 0
    bucket.peakRequests = 0
    bucket.offPeakRequests = 0
    bucket.cacheHitTokens = 0
    bucket.cacheMissTokens = 0
    bucket.outputTokens = 0
    bucket.cost = 0
  }

  for (const event of acc.events) {
    if (event.decayed) continue
    const base = resolveModel(event.model, catalog)
    const override = overrideOf(event.model.toLowerCase(), base)
    const attrs = override !== undefined ? { ...base, override, fallback: false } : base
    const peak = isPeakTime(event.time)
    const band = peak ? 'peak' : 'offPeak'
    const row = override ?? PRICING[attrs.pricingModel] ?? PRICING[FALLBACK_KEY]
    const cost = (event.hit * row.cacheHit[band] + event.miss * row.cacheMiss[band] + event.output * row.output[band]) / 1e6

    const bucket = modelBucket(acc, event.model, attrs)
    bucket.requests += 1
    if (peak) bucket.peakRequests += 1
    else bucket.offPeakRequests += 1
    bucket.cacheHitTokens += event.hit
    bucket.cacheMissTokens += event.miss
    bucket.outputTokens += event.output
    bucket.cost += cost

    acc.requests += 1
    if (peak) acc.peakRequests += 1
    else acc.offPeakRequests += 1
    acc.inputTokens += event.prompt
    acc.cacheHitTokens += event.hit
    acc.cacheMissTokens += event.miss
    acc.outputTokens += event.output
    acc.totalCost += cost
    if (acc.firstTime === undefined) acc.firstTime = event.time
    acc.lastTime = event.time

    if (event.turn !== undefined && event.turn !== null) {
      const turnBucket = acc.turns.get(String(event.turn))
      if (turnBucket !== undefined) {
        turnBucket.requests += 1
        if (peak) turnBucket.peakRequests += 1
        else turnBucket.offPeakRequests += 1
        turnBucket.cacheHitTokens += event.hit
        turnBucket.cacheMissTokens += event.miss
        turnBucket.outputTokens += event.output
        turnBucket.cost += cost
      }
    }
  }
  acc.repriced = true
}

/**
 * Fold a list of already-loaded events into an accumulator.
 * @param acc - the target accumulator
 * @param events - session events in seq order
 * @param catalog - lowercased runtime model ids, or null
 * @returns the same accumulator
 */
function foldEvents(acc, events, catalog) {
  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : -1
    if (seq >= 0) acc.lastSeq = Math.max(acc.lastSeq, seq)
    const data = event.data
    if (data === null || typeof data !== 'object') continue

    if (event.type === 'turn/start') {
      ensureTurn(acc, data.turn, seq, true)
      continue
    }
    if (event.type === 'turn/end') {
      const turnBucket = ensureTurn(acc, data.turn, seq, false)
      turnBucket.endSeq = seq
      continue
    }
    if (event.type !== 'assistant/message') continue

    const usage = data.usage
    if (usage === null || typeof usage !== 'object') continue
    const source = data.message !== undefined && data.message !== null ? data.message.source : undefined
    const model = source !== undefined && source !== null ? source.model : undefined
    recordUsage(acc, usage, model, typeof event.time === 'number' ? event.time : Date.now(), data.turn, seq, catalog)
  }
  return acc
}

/**
 * Fold every not-yet-seen event of one live Session into its accumulator.
 * @param session - the live Session
 * @param catalog - lowercased runtime model ids, or null when the llm service is absent
 * @returns the up-to-date accumulator
 */
function foldSession(session, catalog) {
  let acc = fallbacks.get(session)
  if (acc === undefined) {
    acc = createAccumulator()
    fallbacks.set(session, acc)
  }
  let events
  try {
    events = session.snapshotEvents(acc.lastSeq + 1)
  } catch {
    return acc
  }
  return foldEvents(acc, events, catalog)
}

/**
 * Snap one event's kept inputs to zero once its own aggregate has been repriced,
 * so the retention cap never drops accounting that the totals still carry.
 * @param acc - the accumulator holding the event list
 * @param kept - the event record to decay
 */
function markDecayed(acc, kept) {
  if (kept !== null && kept !== undefined) {
    kept.decayed = true
    kept.prompt = 0
    kept.hit = 0
    kept.miss = 0
    kept.output = 0
    kept.cost = 0
    return
  }
  for (const candidate of acc.events) {
    if (!candidate.decayed) {
      markDecayed(acc, candidate)
      return
    }
  }
}

/* ------------------------- subagent session merge ------------------------- */

/** How long the on-disk session index stays usable. */
const INDEX_TTL_MS = 10000

/** Bytes read to recover one session's header frame before falling back. */
const HEADER_CHUNK_BYTES = 65536

/** Largest log the header reader will load whole when the chunk misses. */
const HEADER_FULL_READ_LIMIT = 8 * 1024 * 1024

/** Zstd frame magic, the only reliable frame delimiter in these logs. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Cached header index: `{ at, byId }`. */
let headerIndex = { at: 0, byId: new Map() }

/** Cached folds for logs that belong to sessions this process does not hold. */
const logFolds = new Map()

/** DSH home directory: env override first, then the official default. */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim()) return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * Recover the header object of one session log.
 *
 * A log is a series of independently compressed zstd frames appended one flush
 * at a time; the header always sits alone in the first frame, so only that frame
 * is decoded.
 *
 * @param file - the `.jsonl.zstd` log path
 * @returns the parsed header, or undefined when the frame cannot be read
 */
function readSessionHeader(file) {
  let size
  try {
    size = statSync(file).size
  } catch {
    return undefined
  }
  let chunk
  const fd = openSync(file, 'r')
  try {
    const length = Math.min(size, HEADER_CHUNK_BYTES)
    chunk = Buffer.alloc(length)
    readSync(fd, chunk, 0, length, 0)
  } finally {
    closeSync(fd)
  }
  const decode = (buffer) => {
    const first = buffer.indexOf(ZSTD_MAGIC, 0)
    if (first !== 0) return undefined
    const second = buffer.indexOf(ZSTD_MAGIC, 4)
    const end = second === -1 ? buffer.length : second
    try {
      const text = zstdDecompressSync(buffer.subarray(0, end)).toString('utf8')
      const line = text.split('\n', 1)[0]
      const header = JSON.parse(line)
      return header !== null && typeof header === 'object' ? header : undefined
    } catch {
      return undefined
    }
  }
  const fromChunk = decode(chunk)
  if (fromChunk !== undefined) return fromChunk
  if (size > HEADER_FULL_READ_LIMIT) return undefined
  try {
    return decode(readFileSync(file))
  } catch {
    return undefined
  }
}

/**
 * List every session log on disk with the header facts needed to wire children.
 * @returns a Map of session id to its log path and lineage
 */
function loadSessionIndex() {
  if (Date.now() - headerIndex.at < INDEX_TTL_MS) return headerIndex.byId
  const byId = new Map()
  const root = join(dshHome(), 'sessions')
  let projects = []
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    headerIndex = { at: Date.now(), byId }
    return byId
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions = []
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir, session.name)
      let files = []
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      const log = files.find((name) => name.endsWith('.jsonl.zstd'))
      if (log === undefined) continue
      const file = join(dir, log)
      const header = readSessionHeader(file)
      if (header === undefined || typeof header.id !== 'string') continue
      byId.set(header.id, {
        id: header.id,
        file,
        parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
        depth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
        origin: header.origin,
      })
    }
  }
  headerIndex = { at: Date.now(), byId }
  return byId
}

/**
 * Decode every event of one session log.
 * @param file - the `.jsonl.zstd` log path
 * @returns the events in file order
 */
function readLogEvents(file) {
  const buf = readFileSync(file)
  const parts = []
  let at = buf.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    const next = buf.indexOf(ZSTD_MAGIC, at + 4)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zstdDecompressSync(buf.subarray(at, end)).toString('utf8'))
    } catch {
      // A torn frame only loses that flush.
    }
    at = next
  }
  const events = []
  for (const line of parts.join('').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn trailing line is expected after a crash.
    }
  }
  return events
}

/**
 * Fold one on-disk session log, cached by file generation.
 * @param entry - the index entry naming the log
 * @param catalog - lowercased runtime model ids, or null
 * @param overrides - configured price overrides, or null
 * @returns the folded accumulator
 */
function foldLogEntry(entry, catalog, overrides) {
  let stat
  try {
    stat = statSync(entry.file)
  } catch {
    return createAccumulator()
  }
  const cached = logFolds.get(entry.id)
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.acc

  const acc = createAccumulator()
  foldEvents(acc, readLogEvents(entry.file), catalog)
  if (overrides !== null || catalog !== null) reprice(acc, catalog, overrides)
  logFolds.set(entry.id, { size: stat.size, mtimeMs: stat.mtimeMs, acc })
  return acc
}

/**
 * Collect every subagent descendant of one session, live or finished.
 *
 * Only `origin: 'subagent'` children count: a user fork also records a
 * `parentSession` but is an independent conversation, so merging it would
 * charge one branch for another.
 *
 * @param ctx - the plugin context
 * @param rootId - the session whose subtree is collected
 * @returns the descendants, nearest first
 */
function collectDescendants(ctx, rootId) {
  const index = loadSessionIndex()
  const live = new Map()
  let sessions = []
  try {
    sessions = ctx.sessions.list()
  } catch {
    sessions = []
  }
  for (const session of sessions) {
    try {
      live.set(session.id, session)
    } catch {
      // A session that cannot report its id is skipped.
    }
  }

  const childrenByParent = new Map()
  const link = (childId, lineage) => {
    const parentId = lineage.parentSession
    if (parentId === undefined || lineage.origin !== 'subagent') return
    let list = childrenByParent.get(parentId)
    if (list === undefined) {
      list = []
      childrenByParent.set(parentId, list)
    }
    list.push({ id: childId, ...lineage })
  }

  for (const [id, entry] of index) link(id, entry)
  for (const [id, session] of live) {
    const header = session.header
    if (header === undefined || header === null) continue
    link(id, {
      parentSession: header.parentSession,
      origin: header.origin,
      depth: header.delegationDepth ?? 0,
      file: index.get(id)?.file,
    })
  }

  const found = []
  const seen = new Set([rootId])
  const queue = [{ id: rootId, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    const children = childrenByParent.get(current.id) ?? []
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      const depth = current.depth + 1
      found.push({ id: child.id, depth, live: live.get(child.id), file: child.file })
      queue.push({ id: child.id, depth })
    }
  }
  return found
}

/**
 * Fold one accumulator's model buckets into a merge target, summing same-model rows.
 * @param target - map of model id to the merged bucket
 * @param source - the accumulator whose buckets are merged in
 */
function mergeModels(target, source) {
  for (const bucket of source.models.values()) {
    const existing = target.get(bucket.model)
    if (existing === undefined) {
      target.set(bucket.model, { ...bucket })
      continue
    }
    existing.requests += bucket.requests
    existing.peakRequests += bucket.peakRequests
    existing.offPeakRequests += bucket.offPeakRequests
    existing.cacheHitTokens += bucket.cacheHitTokens
    existing.cacheMissTokens += bucket.cacheMissTokens
    existing.outputTokens += bucket.outputTokens
    existing.cost += bucket.cost
  }
}

/** Serialize an accumulator into the route payload. */
function describe(sessionId, acc, catalog, descendants = []) {
  const mergedModels = new Map()
  mergeModels(mergedModels, acc)
  for (const descendant of descendants) mergeModels(mergedModels, descendant.acc)

  const models = [...mergedModels.values()]
    .map((bucket) => ({
      model: bucket.model,
      pricingModel: bucket.pricingModel,
      pricingLabel: bucket.pricingLabel,
      fallback: bucket.fallback,
      match: bucket.match,
      rateSource: bucket.rateSource,
      aliasOf: bucket.aliasOf,
      requests: bucket.requests,
      peakRequests: bucket.peakRequests,
      offPeakRequests: bucket.offPeakRequests,
      cacheHitTokens: bucket.cacheHitTokens,
      cacheMissTokens: bucket.cacheMissTokens,
      outputTokens: bucket.outputTokens,
      cost: bucket.cost,
    }))
    .sort((left, right) => right.cost - left.cost)
  // Turns stay parent-only: a child's turn numbers are its own, so interleaving
  // them into the transcript's turn map would attach costs to the wrong rows.
  const turns = [...acc.turns.values()]
    .filter((bucket) => bucket.requests > 0)
    .map((bucket) => ({
      turn: bucket.turn,
      startSeq: bucket.startSeq !== undefined ? bucket.startSeq : bucket.firstSeq,
      endSeq: bucket.endSeq !== undefined ? bucket.endSeq : Math.max(bucket.lastSeq, acc.lastSeq),
      requests: bucket.requests,
      peakRequests: bucket.peakRequests,
      offPeakRequests: bucket.offPeakRequests,
      cacheHitTokens: bucket.cacheHitTokens,
      cacheMissTokens: bucket.cacheMissTokens,
      outputTokens: bucket.outputTokens,
      cost: bucket.cost,
    }))
    .sort((left, right) => left.startSeq - right.startSeq)

  const children = descendants.map((descendant) => ({
    sessionId: descendant.id,
    depth: descendant.depth,
    live: descendant.live !== undefined,
    requests: descendant.acc.requests,
    inputTokens: descendant.acc.inputTokens,
    outputTokens: descendant.acc.outputTokens,
    cost: descendant.acc.totalCost,
  }))
  const childCost = children.reduce((sum, child) => sum + child.cost, 0)
  const childRequests = children.reduce((sum, child) => sum + child.requests, 0)
  let firstTime = acc.firstTime
  let lastTime = acc.lastTime
  let peakRequests = acc.peakRequests
  let offPeakRequests = acc.offPeakRequests
  let requests = acc.requests
  let inputTokens = acc.inputTokens
  let cacheHitTokens = acc.cacheHitTokens
  let cacheMissTokens = acc.cacheMissTokens
  let outputTokens = acc.outputTokens
  for (const descendant of descendants) {
    const child = descendant.acc
    requests += child.requests
    peakRequests += child.peakRequests
    offPeakRequests += child.offPeakRequests
    inputTokens += child.inputTokens
    cacheHitTokens += child.cacheHitTokens
    cacheMissTokens += child.cacheMissTokens
    outputTokens += child.outputTokens
    if (child.firstTime !== undefined && (firstTime === undefined || child.firstTime < firstTime)) firstTime = child.firstTime
    if (child.lastTime !== undefined && (lastTime === undefined || child.lastTime > lastTime)) lastTime = child.lastTime
  }

  return {
    ok: true,
    sessionId,
    currency: 'CNY',
    pricingVersion: PRICING_VERSION,
    totalCost: acc.totalCost + childCost,
    ownCost: acc.totalCost,
    childCost,
    ownRequests: acc.requests,
    childRequests,
    requests,
    peakRequests,
    offPeakRequests,
    inputTokens,
    cacheHitTokens,
    cacheMissTokens,
    outputTokens,
    models,
    turns,
    children,
    firstTime,
    lastTime,
    updatedAt: Date.now(),
    repriced: acc.repriced,
    catalogSize: catalog ? catalog.size : 0,
  }
}

/** Loopback literal check plus browser same-origin markers. */
function isLoopbackRequest(request) {
  const address = request.socket !== undefined && request.socket !== null ? request.socket.remoteAddress : undefined
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write a JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * Read the models this runtime actually serves, lowercased.
 * An absent service or a provider without a catalog simply contributes nothing.
 * @param llm - the optional `llm` service
 * @returns the known model ids, or null when the service is unavailable
 */
async function loadCatalog(llm, budgets = new Map()) {
  if (llm === undefined || llm === null) return null
  const ids = new Set()
  let providers = []
  try {
    providers = llm.listProviders()
  } catch {
    return ids
  }
  const tasks = []
  for (const info of providers) {
    const provider = typeof info === 'string' ? info : info !== null && info !== undefined ? info.id : undefined
    if (typeof provider !== 'string') continue
    // A provider whose catalog hangs must not hold up the whole refresh.
    const budget = budgets.get(provider)
    if (budget !== undefined && budget.timedOut) continue
    tasks.push(
      new Promise((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          budgets.set(provider, { timedOut: true })
          resolve()
        }, CATALOG_TIMEOUT_MS)
        Promise.resolve()
          .then(() => llm.listModels(provider))
          .then((models) => {
            for (const model of models ?? []) {
              if (model !== null && model !== undefined && typeof model.id === 'string') ids.add(model.id.toLowerCase())
            }
          })
          .catch(() => {
            // A provider that cannot enumerate its catalog contributes no ids.
          })
          .finally(() => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve()
          })
      }),
    )
  }
  await Promise.all(tasks)
  return ids
}

/**
 * Normalize the optional configuration's price overrides.
 *
 * `config.pricing` is a plain object: `{ "<model id>" | "<price row>" | "*":
 * { cacheHit, cacheMiss, output } }`, in CNY per 1M tokens at PEAK time (the
 * off-peak band is half, matching the official table). Validation is done here
 * rather than through a schema so the bundle stays dependency-free; a malformed
 * row is reported in `warnings` and ignored.
 *
 * @param config - the plugin row config
 * @returns the overrides keyed by pricing model, plus any warnings
 */
function readPricingConfig(config) {
  const warnings = []
  const out = {}
  const pricing = config !== null && config !== undefined ? config.pricing : undefined
  if (pricing === undefined || pricing === null) return { overrides: null, warnings }
  if (typeof pricing !== 'object' || Array.isArray(pricing)) {
    warnings.push('pricing must be an object of { "<model or row>": { cacheHit, cacheMiss, output } }')
    return { overrides: null, warnings }
  }
  for (const [key, row] of Object.entries(pricing)) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      warnings.push(`pricing.${key} must be an object`)
      continue
    }
    const price = (field) => {
      if (row[field] === undefined) return undefined
      const parsed = Number(row[field])
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN
    }
    const peakMiss = price('cacheMiss')
    const peakOut = price('output')
    const peakHit = price('cacheHit')
    if (!Number.isFinite(peakMiss) || !Number.isFinite(peakOut)) {
      warnings.push(`pricing.${key} needs numeric cacheMiss and output`)
      continue
    }
    if (Number.isNaN(peakHit)) {
      warnings.push(`pricing.${key}.cacheHit must be a non-negative number`)
      continue
    }
    out[key.toLowerCase()] = {
      cacheHit: { peak: peakHit ?? peakMiss, offPeak: (peakHit ?? peakMiss) / 2 },
      cacheMiss: { peak: peakMiss, offPeak: peakMiss / 2 },
      output: { peak: peakOut, offPeak: peakOut / 2 },
    }
  }
  return { overrides: Object.keys(out).length > 0 ? out : null, warnings }
}

/** Mount the conversation-cost route. */
export function apply(ctx, config) {
  let catalog = null
  let catalogTimer
  const refreshCatalog = () => {
    loadCatalog(ctx.get('llm'), new Map())
      .then((ids) => {
        catalog = ids
      })
      .catch(() => {
        catalog = catalog ?? null
      })
  }
  refreshCatalog()
  // Adapter or model changes can add ids; refresh in the background.
  ctx.on('llm/adapters-updated', refreshCatalog)
  ctx.on('llm/models-updated', refreshCatalog)
  catalogTimer = setInterval(refreshCatalog, 5 * 60 * 1000)
  if (typeof catalogTimer.unref === 'function') catalogTimer.unref()
  ctx.effect(() => () => clearInterval(catalogTimer), 'dsh-conversation-cost: catalog refresh')

  const pricingConfig = readPricingConfig(config)
  const overrides = pricingConfig.overrides
  for (const warning of pricingConfig.warnings) ctx.logger?.warn?.(`conversation-cost: ${warning}`)
  const catalogBudgets = new Map()

  const sessionRoute = {
    kind: 'exact',
    path: API_PREFIX + '/session',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, reason: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, reason: 'method not allowed: ' + req.method })
        return
      }
      let sessionId
      try {
        sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId')
      } catch {
        sessionId = null
      }
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        writeJson(res, 400, { ok: false, reason: 'sessionId is required' })
        return
      }
      try {
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) {
          writeJson(res, 404, { ok: false, reason: 'not-live', sessionId })
          return
        }
        // Use the freshest catalog; the first read waits for it so a model that
        // joined the runtime after early usage is still recognized.
        if (catalog === null) {
          const loaded = await loadCatalog(ctx.get('llm'), catalogBudgets)
          if (loaded !== null) catalog = loaded
        }
        const acc = foldSession(session, catalog)
        if (!acc.repriced && (overrides !== null || catalog !== null)) reprice(acc, catalog, overrides)

        // Subagent children run in their own sessions; their spend belongs to the
        // conversation that spawned them.
        const descendants = []
        for (const child of collectDescendants(ctx, sessionId)) {
          try {
            const childAcc =
              child.live !== undefined
                ? foldSession(child.live, catalog)
                : child.file !== undefined && existsSync(child.file)
                  ? foldLogEntry({ id: child.id, file: child.file }, catalog, overrides)
                  : undefined
            if (childAcc === undefined) continue
            if (!childAcc.repriced && (overrides !== null || catalog !== null)) reprice(childAcc, catalog, overrides)
            descendants.push({ id: child.id, depth: child.depth, live: child.live, acc: childAcc })
          } catch {
            // A child whose log cannot be read must not fail the parent's figure.
          }
        }

        writeJson(res, 200, describe(sessionId, acc, catalog, descendants))
      } catch (error) {
        writeJson(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const pricingRoute = {
    kind: 'exact',
    path: API_PREFIX + '/pricing',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, reason: 'forbidden: loopback-only' })
        return
      }
      try {
        if (catalog === null) {
          const loaded = await loadCatalog(ctx.get('llm'), catalogBudgets)
          if (loaded !== null) catalog = loaded
        }
      } catch {
        // Serve the static table even when the catalog cannot be read.
      }
      writeJson(res, 200, {
        ok: true,
        currency: 'CNY',
        pricingVersion: PRICING_VERSION,
        unit: 'CNY per 1M tokens',
        peakHours: 'Beijing-time weekdays 09:00-12:00 and 14:00-18:00; other hours are half price',
        rows: PRICING,
        overrides: overrides !== null ? Object.keys(overrides) : [],
        catalog: catalog !== null ? [...catalog].sort() : null,
      })
    },
  }

  ctx.effect(
    () => {
      const disposeSession = ctx.webServer.register(sessionRoute)
      const disposePricing = ctx.webServer.register(pricingRoute)
      return () => {
        disposeSession()
        disposePricing()
      }
    },
    'dsh-conversation-cost: route',
  )
}
