/**
 * Regression net for the host half.
 *
 * Two entry points, two different obligations:
 *
 * - `/redo <seq>` **retracts now**. Turn boundaries are not this plugin's to
 *   invent: it reads the host's `turnBoundary` fold, writes a Turn only between
 *   Turns and only with the number that follows the last one, and refuses the
 *   click while a Turn is still open. A `system/message` outside an open
 *   turn+step, a second `turn/start` inside one, or an off-by-one Turn number
 *   each make the next JSONL read reject the log, so this file locks all three.
 * - A `redo:<seq>:<uuid>` prompt **retries**, and the replacement must land in
 *   the step that claimed it — `agent/pre-step` records the plan, `agent/request`
 *   consumes it exactly once.
 *
 * The hooks are exercised through `apply(ctx)` — the same path the host uses —
 * rather than through an exported helper. The last test reads what the plugin
 * wrote back with the release V4 validator, which is the code that answers a GUI
 * history load, so "the plugin writes a log the host still accepts" is asserted
 * against the host, not against this plugin's own idea of correctness.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'

import { apply } from '../src/index.ts'

/** A message source as the loop hands it to `agent/pre-step`. */
interface FakeSource {
  readonly kind: string
  readonly rpcId?: string
}

interface FakeMessage {
  readonly source: FakeSource
}

/** One recorded append, whatever the event type. */
interface RecordedAppend {
  readonly type: string
  readonly data: {
    readonly turn?: number
    readonly step?: number
    readonly message?: {
      readonly id: string
      readonly role: string
      readonly content: readonly unknown[]
      readonly source: { readonly kind: string }
    }
  }
  readonly options?: {
    readonly surfaceOp: {
      readonly op: string
      readonly startSeq: number
      readonly endSeq: number
    }
    readonly sourceEventSeqs: readonly number[]
  }
}

/** One already-committed event the log holds before the plugin runs. */
interface LoggedEvent {
  readonly type: string
  readonly data: unknown
}

type Handler = (payload: unknown, next: () => Promise<void>) => unknown

/** One registered command, as the fake registry keeps it. */
interface FakeCommand {
  readonly name: string
  readonly handler: (invocation: unknown) => unknown
}

/** Minimal stand-in for the agent's session surface and log. */
interface FakeSession {
  readonly surface: { readonly nodes: readonly number[] }
  readonly appends: RecordedAppend[]
  readonly log: readonly LoggedEvent[]
  eventAt(seq: number): unknown
  snapshotEvents(): readonly LoggedEvent[]
  append(type: string, data: unknown, options?: unknown): void
}

interface FakeAgent {
  readonly session: FakeSession
}

/** Minimal stand-in for the command registry `ctx.commands`. */
interface FakeCommands {
  readonly registered: Map<string, FakeCommand>
  register(command: FakeCommand): () => void
}

/** Minimal stand-in for the cordis context. */
interface FakeCtx {
  readonly handlers: Map<string, Handler[]>
  readonly commands: FakeCommands
  readonly sessionProjections: {
    stateOf(session: unknown, key: string): unknown
  }
  on(event: string, handler: Handler): () => void
  effect(factory: () => (() => void) | void, label?: string): void
}

/** A session whose last Turn already closed: the only moment a retraction may write. */
const BETWEEN_TURNS: TurnBoundaryProjection = {
  openTurnStartSeq: null,
  lastStepStartSeq: null,
  lastStepBoundary: null,
  lastTurn: 0,
}

/** Build a session whose surface is `nodes`, appends recorded in order. */
function fakeSession(
  nodes: readonly number[],
  events: ReadonlyMap<number, unknown>,
  log: readonly LoggedEvent[],
): FakeSession {
  const appends: RecordedAppend[] = []
  return {
    surface: { nodes },
    appends,
    log,
    eventAt(seq) { return events.get(seq) },
    snapshotEvents() { return log },
    append(type, data, options) {
      appends.push({ type, data, options } as RecordedAppend)
    },
  }
}

function fakeCtx(boundary: TurnBoundaryProjection): FakeCtx {
  const handlers = new Map<string, Handler[]>()
  const registered = new Map<string, FakeCommand>()
  return {
    handlers,
    commands: {
      registered,
      register(command) {
        registered.set(command.name, command)
        return () => { registered.delete(command.name) }
      },
    },
    sessionProjections: {
      stateOf(_session, key) { return key === 'turnBoundary' ? boundary : undefined },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => { handlers.delete(event) }
    },
    effect(factory) { factory() },
  }
}

/** Install the plugin on a fresh context and agent. */
function harness(
  nodes: readonly number[],
  events: ReadonlyMap<number, unknown>,
  boundary: TurnBoundaryProjection = BETWEEN_TURNS,
  log: readonly LoggedEvent[] = [],
) {
  const ctx = fakeCtx(boundary)
  const session = fakeSession(nodes, events, log)
  const agent: FakeAgent = { session }
  // The plugin registers hooks, effects, and one command, and only reads
  // `session` off the agent, so this cast is the whole test seam.
  apply(ctx as unknown as Context)
  return { ctx, session, agent }
}

/** Fire one hook, waiting for its `next()` continuation like the host does. */
async function emit(ctx: FakeCtx, event: string, payload: unknown): Promise<void> {
  const list = ctx.handlers.get(event)
  assert.ok(list !== undefined && list.length > 0, `no handler registered for ${event}`)
  for (const handler of list) {
    await handler(payload, async () => {})
  }
}

/** Run one registered command the way the dispatcher does. */
function runCommand(ctx: FakeCtx, agent: FakeAgent, rawInput: string): unknown {
  const command = ctx.commands.registered.get('redo')
  assert.ok(command !== undefined, 'the /redo command was not registered')
  return command.handler({ agent, rawInput, commandId: 'test', attachments: [], signal: new AbortController().signal })
}

/** A retry prompt as the client mints it: `redo:<targetSeq>:<uuid>`. */
function redoMessage(target: number): FakeMessage {
  return { source: { kind: 'user', rpcId: `redo:${String(target)}:5f2b1c0e-8a44-4d7f-9c1e-2b6a3d5e7f90` } }
}

/** An ordinary composer prompt: the composer mints its own request id. */
const HUMAN_PROMPT: FakeMessage = {
  source: { kind: 'user', rpcId: 'b0b0b0b0-1111-4222-8333-444455556666' },
}

/** The event a real committed user message carries. */
const USER_EVENT = { type: 'user/message', data: { source: { kind: 'user' } } }

/** Narrow the single non-boundary append, failing loudly on zero or many. */
function onlyMessageAppend(session: FakeSession): RecordedAppend {
  const messages = session.appends.filter(append => append.type === 'system/message')
  assert.equal(messages.length, 1, 'expected exactly one message append')
  const append = messages[0]
  assert.ok(append !== undefined)
  return append
}

// ---------------------------------------------------------------------------
// /redo — retract now
// ---------------------------------------------------------------------------

test('the command retracts immediately inside a Turn it opens and closes', () => {
  const nodes = [1, 4, 12, 20, 33]
  const target = 12
  const { ctx, agent, session } = harness(nodes, new Map([[target, USER_EVENT]]), {
    ...BETWEEN_TURNS,
    lastTurn: 6,
  })

  assert.deepEqual(runCommand(ctx, agent, ` ${String(target)}`), { kind: 'success' })

  const shadowed = nodes.slice(nodes.indexOf(target))
  assert.deepEqual(session.appends.map(append => append.type), [
    'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
  ])

  const [turnStart, stepStart, message, stepEnd, turnEnd] = session.appends
  // The Turn follows the host's fold, not a scan of the log: the loop opens 8 next.
  assert.deepEqual(turnStart?.data, { turn: 7 })
  assert.deepEqual(stepStart?.data, { turn: 7, step: 1 })
  assert.deepEqual(message?.data.turn, 7)
  assert.deepEqual(message?.data.step, 1)
  assert.deepEqual(stepEnd?.data, { turn: 7, step: 1 })
  assert.deepEqual(turnEnd?.data, { turn: 7, reason: { kind: 'completed' } })

  // Constraint: exactly one replacement, spanning the target through the tail.
  assert.deepEqual(message?.options?.surfaceOp, {
    op: 'replace',
    startSeq: shadowed[0],
    endSeq: shadowed.at(-1),
  })
  // Constraint: `sourceEventSeqs` covers every shadowed surface node, no more.
  assert.deepEqual([...(message?.options?.sourceEventSeqs ?? [])], shadowed)
})

test('a click inside an open Turn is refused and leaves the log untouched', () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]), {
    ...BETWEEN_TURNS,
    // The loop is still writing inside Turn 2: a second `turn/start` here is the
    // one event a cold read answers with "does not open the expected turn".
    openTurnStartSeq: 4 as never,
    lastTurn: 2,
  })

  const result = runCommand(ctx, agent, '9') as { kind: string, text?: string }

  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /still generating/)
  assert.equal(session.appends.length, 0, 'a refused retraction must not touch the log')
})

test('a host without the turnBoundary fold is an error, not a guess', () => {
  const ctx = fakeCtx(BETWEEN_TURNS)
  const session = fakeSession([1, 9], new Map([[9, USER_EVENT]]), [])
  // A composition that never registered the fold cannot tell between Turns.
  const blind = {
    ...ctx,
    sessionProjections: { stateOf: () => undefined },
  }
  apply(blind as unknown as Context)

  const command = blind.commands.registered.get('redo')
  assert.ok(command !== undefined)
  assert.throws(
    () => command.handler({ agent: { session }, rawInput: '9', commandId: 'test', attachments: [], signal: new AbortController().signal }),
    /no turnBoundary projection/,
  )
  assert.equal(session.appends.length, 0)
})

test('the replacement is an empty system node and never a user message', () => {
  const { ctx, agent, session } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')

  const message = onlyMessageAppend(session)
  assert.equal(message.data.message?.role, 'system')
  assert.deepEqual([...(message.data.message?.content ?? [])], [])
  assert.notEqual(message.data.message?.source.kind, 'user')
})

test('a session with no Turn yet starts the retraction at Turn 1', () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')

  assert.deepEqual(session.appends[0]?.data, { turn: 1 })
})

test('a retraction never leaves a Step open', () => {
  const { ctx, agent, session } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')

  const tail = session.appends.slice(-2).map(append => append.type)
  assert.deepEqual(tail, ['step/end', 'turn/end'])
})

test('each retraction mints a fresh empty node identity', () => {
  const first = harness([1, 9], new Map([[9, USER_EVENT]]))
  runCommand(first.ctx, first.agent, '9')
  const second = harness([1, 9], new Map([[9, USER_EVENT]]))
  runCommand(second.ctx, second.agent, '9')

  assert.notEqual(
    onlyMessageAppend(first.session).data.message?.id,
    onlyMessageAppend(second.session).data.message?.id,
  )
})

test('the command refuses what the rewind would refuse, and bad arguments', () => {
  const assistant = { type: 'assistant/message', data: { source: { kind: 'assistant' } } }
  const events = new Map<number, unknown>([[1, USER_EVENT], [9, assistant], [17, USER_EVENT]])
  const { ctx, agent, session } = harness([1, 9, 17], events)

  for (const rawInput of ['', 'abc', '0x10', '9.5', '-3']) {
    const result = runCommand(ctx, agent, rawInput) as { kind: string }
    assert.equal(result.kind, 'error', `accepted ${JSON.stringify(rawInput)}`)
  }
  // A target outside the surface, the protected head, and a non-human node.
  for (const rawInput of ['42', '1', '9']) {
    const result = runCommand(ctx, agent, rawInput) as { kind: string }
    assert.equal(result.kind, 'error', `accepted ${rawInput}`)
  }
  assert.equal(session.appends.length, 0, 'a refused command must not touch the log')

  // A valid target still retracts after those refusals.
  assert.deepEqual(runCommand(ctx, agent, '17'), { kind: 'success' })
  assert.equal(onlyMessageAppend(session).options?.surfaceOp.startSeq, 17)
})

// ---------------------------------------------------------------------------
// redo:<seq>:<uuid> — retry inside the claiming step
// ---------------------------------------------------------------------------

test('the rewind shadows the whole surface tail in one append inside the open step', async () => {
  const nodes = [1, 4, 12, 20, 33]
  const target = 12
  const turn = 7
  const step = 2
  const events = new Map<number, unknown>([[target, USER_EVENT]])
  const { ctx, session, agent } = harness(nodes, events)

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(target)], turn, step })
  await emit(ctx, 'agent/request', { agent, turn, step })

  const append = onlyMessageAppend(session)
  const shadowed = nodes.slice(nodes.indexOf(target))

  assert.equal(append.type, 'system/message')
  // Constraint: a message-producing append must carry the open step's exact
  // coordinates, or the next cold read rejects the log as corrupt.
  assert.equal(append.data.turn, turn)
  assert.equal(append.data.step, step)
  assert.deepEqual(append.options?.surfaceOp, {
    op: 'replace',
    startSeq: shadowed[0],
    endSeq: shadowed.at(-1),
  })
  assert.deepEqual([...(append.options?.sourceEventSeqs ?? [])], shadowed)
  assert.equal(append.data.message?.role, 'system')
  assert.deepEqual([...(append.data.message?.content ?? [])], [])
})

test('an ordinary prompt rewinds nothing', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 0)
})

test('a malformed redo request id is ignored instead of rewinding', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  for (const rpcId of ['redo:abc:uuid', 'redo:-3:uuid', 'redo::uuid', 'redo:0x10:uuid']) {
    await emit(ctx, 'agent/pre-step', {
      agent,
      messages: [{ source: { kind: 'user', rpcId } }],
      turn: 3,
      step: 1,
    })
    await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })
  }

  assert.equal(session.appends.length, 0)
})

test('a redo prompt is scoped to the step that claimed it', async () => {
  const nodes = [1, 9, 17]
  const { ctx, session, agent } = harness(nodes, new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  // A later step of the same turn must not inherit the pending rewind.
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 2 })
  assert.equal(session.appends.length, 0)

  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })
  assert.equal(session.appends.length, 1)
})

test('the plan is consumed once, so a repeated request does not rewind again', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 1)
})

test('a target that left the active context is refused', async () => {
  const { ctx, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(42)], turn: 3, step: 1 })

  await assert.rejects(
    emit(ctx, 'agent/request', { agent, turn: 3, step: 1 }),
    /no longer part of the conversation context/,
  )
})

test('the protected session head cannot be rewound', async () => {
  const nodes = [1, 9, 17]
  const { ctx, agent } = harness(nodes, new Map([[1, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(1)], turn: 3, step: 1 })

  await assert.rejects(
    emit(ctx, 'agent/request', { agent, turn: 3, step: 1 }),
    /first message of a session cannot be rewritten/,
  )
})

test('a node that is not a human user message cannot be rewound', async () => {
  const assistant = { type: 'assistant/message', data: { source: { kind: 'assistant' } } }
  const { ctx, agent } = harness([1, 9, 17], new Map([[9, assistant]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })

  await assert.rejects(
    emit(ctx, 'agent/request', { agent, turn: 3, step: 1 }),
    /only a message you sent can be rewritten/,
  )
})

test('a disposed agent drops its pending retry', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(ctx, 'agent/disposed', { agent })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 0)
})

// ---------------------------------------------------------------------------
// The host's own reader over what the plugin wrote
// ---------------------------------------------------------------------------

/** One surface event of the synthetic stored log. */
interface StoredEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
  readonly surfaceOp?: string | { readonly op: string, readonly startSeq: number, readonly endSeq: number }
  readonly sourceEventSeqs?: readonly number[]
}

/** The event types this fixture uses; the reader interprets every one of them. */
const KNOWN_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'system/message', 'user/message', 'assistant/message',
])

/** The stored header the reader needs; identity matters only for delivery events. */
const HEADER = { id: 'session-redo-test', version: 4, createdAt: 1, cwd: 'D:\\test' }

/**
 * A synthetic stored V4 log the release reader accepts, plus the views the
 * plugin reads off it: surface nodes, event lookup, and the turn boundary fold.
 * @param openTurn - whether generation is in flight at the end of the log.
 */
function storedLog(openTurn: boolean): {
  events: StoredEvent[]
  surface: readonly number[]
  boundary: TurnBoundaryProjection
} {
  const events: StoredEvent[] = []
  const push = (type: string, data: unknown, extra: Omit<Partial<StoredEvent>, 'seq'> = {}): void => {
    events.push({ seq: events.length, time: 1, type, data, ...extra })
  }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('system/message', {
    turn: 1,
    step: 1,
    message: { id: 'head', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'system' }] },
  }, { surfaceOp: 'append' })
  push('user/message', {
    turn: 1,
    step: 1,
    role: 'user',
    content: [{ type: 'text', text: 'first' }],
    source: { kind: 'user', rpcId: '11111111-1111-4111-8111-111111111111' },
  }, { surfaceOp: 'append' })
  push('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'answer' }] },
  }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  if (openTurn) push('turn/start', { turn: 2 })

  return {
    events,
    surface: [2, 3, 4],
    boundary: {
      openTurnStartSeq: openTurn ? (events.length - 1) as never : null,
      lastStepStartSeq: null,
      lastStepBoundary: null,
      lastTurn: openTurn ? 2 : 1,
    },
  }
}

/**
 * Replay the plugin's appends into a real event envelope, which is what the
 * persistence layer would have written.
 * @param stored - events the log already held.
 * @param appends - what the plugin asked the session to append.
 * @returns the log a cold read would see.
 */
function materialize(stored: readonly StoredEvent[], appends: readonly RecordedAppend[]): StoredEvent[] {
  const events = [...stored]
  for (const append of appends) {
    events.push({
      seq: events.length,
      time: 1,
      type: append.type,
      data: append.data,
      ...(append.options === undefined ? {} : {
        surfaceOp: append.options.surfaceOp,
        sourceEventSeqs: append.options.sourceEventSeqs,
      }),
    })
  }
  return events
}

test('a retraction between Turns leaves a log the release validator accepts', () => {
  const stored = storedLog(false)
  const { ctx, agent, session } = harness(stored.surface, new Map(stored.events.map(event => [event.seq, event])), stored.boundary)

  assert.deepEqual(runCommand(ctx, agent, '3'), { kind: 'success' })

  const readBack = materialize(stored.events, session.appends)
  assert.doesNotThrow(
    () => { assertReleasedV4Relationships({ header: HEADER, events: readBack, inheritedEventCount: 0 } as never, KNOWN_TYPES) },
    'the host refused the log the plugin wrote',
  )
})

test('the retraction an open Turn would have corrupted is never written', () => {
  const stored = storedLog(true)
  const { ctx, agent, session } = harness(stored.surface, new Map(stored.events.map(event => [event.seq, event])), stored.boundary)

  assert.equal((runCommand(ctx, agent, '3') as { kind: string }).kind, 'error')
  assert.equal(session.appends.length, 0)

  // The stored log still reads: the session keeps its history and its Turn.
  assert.doesNotThrow(
    () => { assertReleasedV4Relationships({ header: HEADER, events: stored.events, inheritedEventCount: 0 } as never, KNOWN_TYPES) },
  )
})
