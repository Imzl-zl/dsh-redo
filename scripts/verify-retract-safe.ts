/**
 * Would a `/redo` click be safe on this stored session right now?
 *
 * Runs the real host half against a prefix of a real log, then reads the result
 * back with the upstream V4 relationship validator — the code that answers a GUI
 * history load. Two cases, same click:
 *
 * 1. every Turn is closed → the plugin writes the retraction, the read is clean;
 * 2. the tail Turn is still open → the plugin refuses and writes nothing.
 *
 * usage: node scripts/verify-retract-safe.ts <session.v4.jsonl.zstd>
 */

import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'

import { apply } from '../src/index.ts'
import { readSession } from './read-session.mjs'

interface AnyEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
}

interface Appended {
  readonly type: string
  readonly data: unknown
  readonly options?: {
    readonly surfaceOp: { readonly op: string, readonly startSeq: number, readonly endSeq: number }
    readonly sourceEventSeqs: readonly number[]
  }
}

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node scripts/verify-retract-safe.ts <session.v4.jsonl.zstd>')

const { header, events } = readSession(file) as { header: Record<string, unknown>, events: AnyEvent[] }

/** Fold the surface the way the reader does. */
function surfaceOf(log: readonly AnyEvent[]): number[] {
  const nodes: number[] = []
  for (const event of log) {
    const op = event.surfaceOp as { op?: string, startSeq?: number, endSeq?: number } | string | undefined
    if (op === undefined) continue
    if (op === 'append') { nodes.push(event.seq); continue }
    if (typeof op !== 'object' || op.op !== 'replace') continue
    const first = nodes.indexOf(op.startSeq as number)
    const last = nodes.indexOf(op.endSeq as number)
    if (first < 0 || last < first) continue
    nodes.splice(first, last - first + 1, event.seq)
  }
  return nodes
}

/** The `turnBoundary` fold the host hands the plugin. */
function boundaryOf(log: readonly AnyEvent[]): TurnBoundaryProjection {
  let openTurnStartSeq: number | null = null
  let lastTurn = 0
  let lastStepStartSeq: number | null = null
  let lastStepBoundary: TurnBoundaryProjection['lastStepBoundary'] = null
  for (const event of log) {
    if (event.type === 'turn/start') {
      openTurnStartSeq = event.seq
      lastTurn = (event.data as { turn: number }).turn
    }
    if (event.type === 'turn/end') openTurnStartSeq = null
    if (event.type === 'step/start') { lastStepStartSeq = event.seq; lastStepBoundary = { kind: 'start', seq: event.seq as never } }
    if (event.type === 'step/end') lastStepBoundary = { kind: 'end', seq: event.seq as never }
  }
  return { openTurnStartSeq: openTurnStartSeq as never, lastStepStartSeq: lastStepStartSeq as never, lastStepBoundary, lastTurn }
}

/** Replay the plugin's appends into real event envelopes. */
function materialize(prefix: readonly AnyEvent[], appended: readonly Appended[]): AnyEvent[] {
  const out = [...prefix]
  for (const append of appended) {
    out.push({
      seq: out.length,
      time: 1,
      type: append.type,
      data: append.data,
      ...(append.options === undefined ? {} : {
        surfaceOp: append.options.surfaceOp,
        sourceEventSeqs: append.options.sourceEventSeqs,
      }),
    })
  }
  return out
}

/** Drive the real `/redo` handler against one prefix of the stored log. */
function click(prefix: readonly AnyEvent[], target: number): { result: unknown, appended: Appended[] } {
  const nodes = surfaceOf(prefix)
  const bySeq = new Map(prefix.map(event => [event.seq, event]))
  const appended: Appended[] = []
  const registered = new Map<string, { name: string, handler: (invocation: unknown) => unknown }>()
  const ctx = {
    commands: {
      register(command: { name: string, handler: (invocation: unknown) => unknown }) {
        registered.set(command.name, command)
        return () => registered.delete(command.name)
      },
    },
    sessionProjections: {
      stateOf(_session: unknown, key: string) { return key === 'turnBoundary' ? boundaryOf(prefix) : undefined },
    },
    on() { return () => {} },
    effect(factory: () => void) { factory() },
  }
  apply(ctx as unknown as Context)

  const session = {
    surface: { nodes },
    eventAt(seq: number) { return bySeq.get(seq) },
    snapshotEvents() { return prefix },
    append(type: string, data: unknown, options?: Appended['options']) {
      appended.push(options === undefined ? { type, data } : { type, data, options })
    },
  }
  const command = registered.get('redo')
  assert.ok(command !== undefined, 'the /redo command was not registered')
  return {
    result: command.handler({ agent: { session }, rawInput: String(target), commandId: 'verify', attachments: [], signal: new AbortController().signal }),
    appended,
  }
}

/** Read the log back the way a cold history load does. */
function readBack(log: readonly AnyEvent[]): string {
  try {
    assertReleasedV4Relationships({ header, events: log, inheritedEventCount: 0 } as never, new Set(log.map(event => event.type)))
    return 'OK'
  } catch (error) {
    return `REFUSED: ${(error as Error).message}`
  }
}

const lastTurnEnd = events.filter(event => event.type === 'turn/end').at(-1)
assert.ok(lastTurnEnd !== undefined, 'the fixture needs at least one closed turn')

// Case 1: the click happens between Turns — drop the trailing open Turn.
const closedPrefix = events.slice(0, events.indexOf(lastTurnEnd) + 1)
const target = [...surfaceOf(closedPrefix)].reverse().find(seq => {
  const event = closedPrefix.find(item => item.seq === seq)
  return event?.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'user'
})
assert.ok(target !== undefined, 'the fixture needs a human message on the surface')

console.log(`${file}\n  ${events.length} events, ${events.filter(event => event.type === 'turn/start').length} turns, target seq ${target}`)

console.log('\ncase 1 — click between Turns (every Turn closed):')
const clean = click(closedPrefix, target)
console.log(`  command result: ${JSON.stringify(clean.result)}`)
console.log(`  appends: ${clean.appended.map(append => append.type).join(' → ') || '(none)'}`)
console.log(`  cold read: ${readBack(materialize(closedPrefix, clean.appended))}`)

// Case 2: the click happens while the last Turn is still open.
const openPrefix = closedPrefix.slice(0, closedPrefix.length - 1)
const openTurn = openPrefix.filter(event => event.type === 'turn/start').at(-1)
assert.ok(openTurn !== undefined)
console.log(`\ncase 2 — click inside the open Turn ${JSON.stringify(openTurn.data)}:`)
const raced = click(openPrefix, target)
console.log(`  command result: ${JSON.stringify(raced.result)}`)
console.log(`  appends: ${raced.appended.map(append => append.type).join(' → ') || '(none)'}`)
console.log(`  cold read: ${readBack(materialize(openPrefix, raced.appended))}`)
