#!/usr/bin/env node
/**
 * Independent cost audit for one on-disk session log.
 *
 * This script deliberately does NOT import the plugin: it re-reads the raw
 * `session.v4.jsonl.zstd` log, extracts the provider `usage` of every settled
 * assistant message, and re-derives the cost from the official DeepSeek table.
 * Running it next to the plugin's own number is the cross-check that catches
 * accounting mistakes in either one.
 *
 * Usage:
 *   node scripts/verify-log.mjs                 # newest log under ~/.dsh/sessions
 *   node scripts/verify-log.mjs <file-or-dir>   # one session file or directory
 *   node scripts/verify-log.mjs --with-children # also merge subagent descendants
 *   node scripts/verify-log.mjs --json          # machine-readable output
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Official DeepSeek list prices, CNY per 1M tokens (peak band). */
const TABLE = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
}
const FALLBACK = TABLE['deepseek-flash']
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Expand a path or find the most recently written session log. */
function resolveLog(input) {
  const root = join(homedir(), '.dsh', 'sessions')
  if (input === undefined) {
    const found = []
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.jsonl.zstd')) found.push(path)
      }
    }
    walk(root)
    if (found.length === 0) throw new Error(`no session log under ${root}`)
    found.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    return found[0]
  }
  const target = resolve(input)
  if (statSync(target).isDirectory()) {
    const candidate = readdirSync(target).find((name) => name.endsWith('.jsonl.zstd'))
    if (candidate === undefined) throw new Error(`no .jsonl.zstd inside ${target}`)
    return join(target, candidate)
  }
  return target
}

/**
 * Read a session log: the file is a series of independently compressed zstd
 * frames appended one flush at a time, so each frame is decoded on its own.
 */
function readEvents(file) {
  const buf = readFileSync(file)
  const offsets = []
  let at = buf.indexOf(ZSTD_MAGIC, 0)
  while (at !== -1) {
    offsets.push(at)
    at = buf.indexOf(ZSTD_MAGIC, at + 4)
  }
  const parts = []
  let skipped = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      skipped += 1
    }
  }
  const events = []
  for (const line of parts.join('').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a torn trailing line */
    }
  }
  return { events, frames: offsets.length, skipped }
}

/** Peak vs off-peak in Beijing time (Chinese public holidays are not modelled). */
function isPeak(time) {
  const shifted = new Date(time + BEIJING_OFFSET_MS)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return false
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)
}

/** Split one usage report into its billed buckets (see lib/index.js). */
function split(usage) {
  const input = Number(usage.inputTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0)
  const hit = Math.max(0, Number(usage.cacheReadTokens ?? 0))
  const total = Number(usage.totalTokens)
  const near = (value) => Number.isFinite(total) && Math.abs(value - total) <= Math.max(2, total * 0.001)
  if (near(input + output + hit)) return { hit, miss: input }
  if (near(input + output)) return { hit: Math.min(hit, input), miss: Math.max(0, input - hit) }
  if (hit > input) return { hit, miss: input }
  return { hit: Math.min(hit, input), miss: Math.max(0, input - hit) }
}

/** Resolve a model id to a price row. */
function rateOf(model) {
  const id = String(model ?? '').toLowerCase()
  if (TABLE[id] !== undefined) return TABLE[id]
  if (id.includes('pro')) return TABLE['deepseek-v4-pro']
  return FALLBACK
}

/* --------------------------------- main ---------------------------------- */

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const withChildren = args.includes('--with-children')
const input = args.find((arg) => !arg.startsWith('--'))
const file = resolveLog(input)
const { events, frames, skipped } = readEvents(file)

if (events.length === 0) throw new Error(`no readable events in ${file}`)

const byTurn = new Map()
const byModel = new Map()
const totals = { requests: 0, hit: 0, miss: 0, output: 0, cost: 0, peak: 0, offPeak: 0 }

/** Accumulate one session's events into the report tables. */
function addEvents(sessionEvents, trackTurns = true) {
  for (const event of sessionEvents) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (usage === null || usage === undefined) continue
    const { hit, miss } = split(usage)
    const output = Number(usage.outputTokens ?? 0)
    const model = event.data?.message?.source?.model ?? 'unknown'
    const row = rateOf(model)
    const peak = isPeak(event.time)
    const band = peak ? 1 : 0.5
    const cost = (hit * row.hit + miss * row.miss + output * row.out) / 1e6 * band

    totals.requests += 1
    totals.hit += hit
    totals.miss += miss
    totals.output += output
    totals.cost += cost
    if (peak) totals.peak += 1
    else totals.offPeak += 1

    if (trackTurns) {
      const turn = event.data?.turn ?? -1
      const t = byTurn.get(turn) ?? { turn, requests: 0, hit: 0, miss: 0, output: 0, cost: 0 }
      t.requests += 1
      t.hit += hit
      t.miss += miss
      t.output += output
      t.cost += cost
      byTurn.set(turn, t)
    }

    const m = byModel.get(model) ?? { model, requests: 0, hit: 0, miss: 0, output: 0, cost: 0 }
    m.requests += 1
    m.hit += hit
    m.miss += miss
    m.output += output
    m.cost += cost
    byModel.set(model, m)
  }
}

addEvents(events)

/**
 * Find subagent descendants by header lineage across every session log.
 * A user fork also records `parentSession` but has no `origin: 'subagent'`,
 * so it is not merged.
 * @param rootId - the session whose subtree is collected
 * @returns one entry per descendant, nearest first
 */
function findChildren(rootId) {
  const index = new Map()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.jsonl.zstd')) continue
      let sessionEvents
      try {
        sessionEvents = readEvents(path).events
      } catch {
        continue
      }
      const header = sessionEvents.find((event) => event.type === 'session')
      if (header === undefined || typeof header.id !== 'string') continue
      index.set(header.id, { id: header.id, path, header })
    }
  }
  walk(join(homedir(), '.dsh', 'sessions'))

  const found = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const entry of index.values()) {
      if (entry.header.parentSession !== parent) continue
      if (entry.header.origin !== 'subagent') continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const before = { requests: totals.requests, cost: totals.cost }
      addEvents(readEvents(entry.path).events, false)
      found.push({
        sessionId: entry.id,
        requests: totals.requests - before.requests,
        cost: totals.cost - before.cost,
        depth: entry.header.delegationDepth ?? 0,
      })
      queue.push(entry.id)
    }
  }
  return found
}

const sessionEvent = events.find((event) => event.type === 'session')
const ownCost = totals.cost
let children = []
if (withChildren && typeof sessionEvent?.id === 'string') {
  children = findChildren(sessionEvent.id)
}
const report = {
  sessionId: sessionEvent === undefined ? undefined : sessionEvent.id,
  ownCost,
  childCost: totals.cost - ownCost,
  children,
  file,
  frames,
  skippedFrames: skipped,
  events: events.length,
  totals,
  turns: [...byTurn.values()].sort((a, b) => a.turn - b.turn),
  models: [...byModel.values()].sort((a, b) => b.cost - a.cost),
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const n = (value) => value.toLocaleString('en-US')
  console.log(file)
  console.log(`frames ${frames} (${skipped} unreadable), events ${events.length}`)
  console.log('')
  console.log(`requests        ${n(totals.requests)}  (peak ${totals.peak} / off-peak ${totals.offPeak})`)
  console.log(`cache hit       ${n(totals.hit)}`)
  console.log(`cache miss      ${n(totals.miss)}`)
  console.log(`output          ${n(totals.output)}`)
  console.log(`total prompt    ${n(totals.hit + totals.miss)}  (hit rate ${((totals.hit / (totals.hit + totals.miss)) * 100).toFixed(1)}%)`)
  console.log(`cost            ¥${totals.cost.toFixed(6)}`)
  if (withChildren) {
    console.log(`  own           ¥${ownCost.toFixed(6)}`)
    console.log(`  subagents     ¥${(totals.cost - ownCost).toFixed(6)}  (${children.length} session${children.length === 1 ? '' : 's'})`)
    for (const child of children) {
      console.log(`    ${child.sessionId}  depth ${child.depth}  ${child.requests} req  ¥${child.cost.toFixed(6)}`)
    }
  } else if (children.length === 0) {
    console.log('  (run with --with-children to merge subagent sessions)')
  }
  console.log('')
  console.log('per turn:')
  for (const t of report.turns) {
    console.log(`  turn ${String(t.turn).padStart(3)}  ${String(t.requests).padStart(4)} req  ¥${t.cost.toFixed(6)}`)
  }
  console.log('')
  console.log('per model:')
  for (const m of report.models) {
    console.log(`  ${m.model.padEnd(22)} ${String(m.requests).padStart(4)} req  ¥${m.cost.toFixed(6)}`)
  }
}
