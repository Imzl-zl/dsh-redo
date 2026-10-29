/**
 * Regression net for the host half.
 *
 * Two entry points, one append each, and **no turn written by this plugin**:
 *
 * - `/redo <seq>` only arms the next human prompt. It writes nothing, because a
 *   Turn opened from the command would carry a number the loop's own counter
 *   never sees; the loop's next turn then reused it and the next history load
 *   refused the whole session (`turn/start does not open the expected turn`).
 * - `agent/pre-step` records the armed target (or the `redo:<seq>:<uuid>` request
 *   id a retry carries), and `agent/request` writes the replacement inside the
 *   turn+step **the loop opened** — the only public, legal moment.
 *
 * The last test reads what both halves wrote back with the release V4 validator,
 * which is the code that answers a GUI history load.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
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
  on(event: string, handler: Handler): () => void
  effect(factory: () => (() => void) | void, label?: string): void
}

/** Build a session whose surface is `nodes`, appends recorded in order. */
function fakeSession(
  nodes: readonly number[],
  events: ReadonlyMap<number, unknown>,
  log: readonly LoggedEvent[] = [],
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

function fakeCtx(): FakeCtx {
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
  log: readonly LoggedEvent[] = [],
) {
  const ctx = fakeCtx()
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

/** Injected context the loop also claims; it is not a human prompt. */
const CONTEXT_MESSAGE: FakeMessage = { source: { kind: 'runtime-context', rpcId: '' } }

/** The event a real committed user message carries. */
const USER_EVENT = { type: 'user/message', data: { source: { kind: 'user' } } }

/** One full step of a claimed prompt, as the loop drives it. */
async function claimedStep(
  ctx: FakeCtx,
  agent: FakeAgent,
  messages: readonly FakeMessage[],
  turn: number,
  step = 1,
): Promise<void> {
  await emit(ctx, 'agent/pre-step', { agent, messages, turn, step })
  await emit(ctx, 'agent/request', { agent, turn, step })
}

/** Narrow the single replacement append, failing loudly on zero or many. */
function onlyMessageAppend(session: FakeSession): RecordedAppend {
  const messages = session.appends.filter(append => append.type === 'system/message')
  assert.equal(messages.length, 1, 'expected exactly one message append')
  const append = messages[0]
  assert.ok(append !== undefined)
  return append
}

// ---------------------------------------------------------------------------
// arming writes nothing
// ---------------------------------------------------------------------------

test('the command only arms: the click writes nothing to the log', () => {
  const { ctx, agent, session } = harness([1, 4, 12, 20, 33], new Map([[12, USER_EVENT]]))

  assert.deepEqual(runCommand(ctx, agent, ' 12'), { kind: 'success' })
  assert.deepEqual(session.appends, [], 'arming must not open a Turn or write a replacement')
})

test('the replacement lands inside the step the loop claimed, not in a Turn of ours', async () => {
  const nodes = [1, 4, 12, 20, 33]
  const target = 12
  const { ctx, agent, session } = harness(nodes, new Map([[target, USER_EVENT]]))

  runCommand(ctx, agent, String(target))
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 7)

  assert.deepEqual(session.appends.map(append => append.type), ['system/message'])
  const message = onlyMessageAppend(session)
  assert.deepEqual(message.data.turn, 7)
  assert.deepEqual(message.data.step, 1)

  const shadowed = nodes.slice(nodes.indexOf(target))
  assert.deepEqual(message.options?.surfaceOp, {
    op: 'replace',
    startSeq: shadowed[0],
    endSeq: shadowed.at(-1),
  })
  assert.deepEqual([...(message.options?.sourceEventSeqs ?? [])], shadowed)
})

test('the replacement is an empty system node and never a user message', async () => {
  const { ctx, agent, session } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 3)

  const message = onlyMessageAppend(session)
  assert.equal(message.data.message?.role, 'system')
  assert.deepEqual([...(message.data.message?.content ?? [])], [])
  assert.notEqual(message.data.message?.source.kind, 'user')
})

test('one arm drives exactly one send', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 2)
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 3)

  assert.equal(session.appends.length, 1, 'the second send must be an ordinary one')
})

test('an expired arm is consumed without rewriting anything', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  t.mock.timers.tick(6 * 60 * 1000)

  return claimedStep(ctx, agent, [HUMAN_PROMPT], 2).then(() => {
    assert.equal(session.appends.length, 0)
    return claimedStep(ctx, agent, [HUMAN_PROMPT], 3)
  }).then(() => {
    assert.equal(session.appends.length, 0, 'a stale arm cannot rewrite a later message')
  })
})

test('injected context never consumes the arm', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await claimedStep(ctx, agent, [CONTEXT_MESSAGE], 2)
  assert.equal(session.appends.length, 0)
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 3)
  assert.equal(session.appends.length, 1)
})

test('`off` disarms without writing anything', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  assert.deepEqual(runCommand(ctx, agent, 'off'), { kind: 'success' })
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 2)

  assert.equal(session.appends.length, 0)
})

test('a disposed agent drops its arm', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await emit(ctx, 'agent/disposed', { agent })
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 2)

  assert.equal(session.appends.length, 0)
})

// ---------------------------------------------------------------------------
// the retry path keeps its own target
// ---------------------------------------------------------------------------

test('a retry request id names its own target and outranks the arm', async () => {
  const { ctx, agent, session } = harness([1, 9, 17], new Map([[9, USER_EVENT], [17, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await claimedStep(ctx, agent, [redoMessage(17)], 4)

  const message = onlyMessageAppend(session)
  assert.deepEqual(message.options?.surfaceOp, { op: 'replace', startSeq: 17, endSeq: 17 })
})

test('a malformed redo request id is ignored instead of rewinding', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  // `redo::uuid` has no target; `Number()` would read it as 0, the protected head.
  await claimedStep(ctx, agent, [{ source: { kind: 'user', rpcId: 'redo::5f2b1c0e' } }], 2)

  assert.equal(session.appends.length, 0)
})

test('a redo prompt is scoped to the step that claimed it', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 2, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 2, step: 2 })

  assert.equal(session.appends.length, 0)
})

test('the plan is consumed once, so a repeated request does not rewind again', async () => {
  const { ctx, agent, session } = harness([1, 9], new Map([[9, USER_EVENT]]))

  await claimedStep(ctx, agent, [redoMessage(9)], 2)
  await emit(ctx, 'agent/request', { agent, turn: 2, step: 1 })

  assert.equal(session.appends.length, 1)
})

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test('the command refuses a target that left the context, the head, and non-user nodes', () => {
  const { ctx, agent, session } = harness(
    [0, 9, 12],
    new Map<number, unknown>([[9, { type: 'system/message', data: {} }], [12, USER_EVENT]]),
  )

  assert.equal((runCommand(ctx, agent, '99') as { kind: string }).kind, 'error')
  assert.match((runCommand(ctx, agent, '99') as { text: string }).text, /no longer part/)
  assert.match((runCommand(ctx, agent, '0') as { text: string }).text, /first message/)
  assert.match((runCommand(ctx, agent, '9') as { text: string }).text, /only a message you sent/)
  assert.equal((runCommand(ctx, agent, 'abc') as { kind: string }).kind, 'error')
  assert.equal((runCommand(ctx, agent, '1e3') as { kind: string }).kind, 'error')
  assert.deepEqual(session.appends, [])
})

test('a target that left the context before the send fails the turn instead of writing', async () => {
  const nodes = [1, 9]
  const { ctx, agent, session } = harness(nodes, new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  // Another window rewrote the session meanwhile: the surface no longer holds 9.
  ;(nodes as number[]).splice(1, 1)

  await assert.rejects(
    () => claimedStep(ctx, agent, [HUMAN_PROMPT], 2),
    /no longer part of the active context/,
  )
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
 * A synthetic stored V4 log the release reader accepts, plus the surface the
 * plugin reads off it.
 */
function storedLog(): { events: StoredEvent[], surface: readonly number[] } {
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

  return { events, surface: [2, 3, 4] }
}

/**
 * Build the log a real send would leave: the loop opens turn 2 and claims the
 * new prompt, the plugin's replacement lands at `agent/request`, and the new
 * message is appended after it.
 * @param stored - events the log already held.
 * @param replacement - the single append the plugin made.
 * @returns the log a cold read would see.
 */
function materializeSend(stored: readonly StoredEvent[], replacement: RecordedAppend): StoredEvent[] {
  const events = [...stored]
  const push = (type: string, data: unknown, extra: Omit<Partial<StoredEvent>, 'seq'> = {}): void => {
    events.push({ seq: events.length, time: 1, type, data, ...extra })
  }
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('system/message', replacement.data, {
    surfaceOp: replacement.options?.surfaceOp,
    sourceEventSeqs: replacement.options?.sourceEventSeqs,
  })
  push('user/message', {
    turn: 2,
    step: 1,
    role: 'user',
    content: [{ type: 'text', text: 'edited' }],
    source: { kind: 'user', rpcId: '22222222-2222-4222-8222-222222222222' },
  }, { surfaceOp: 'append' })
  push('assistant/message', {
    turn: 2,
    step: 1,
    message: { role: 'assistant', source: { kind: 'assistant' }, content: [{ type: 'text', text: 'again' }] },
  }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  return events
}

test('a send-time retraction leaves a log the release validator accepts', async () => {
  const stored = storedLog()
  const { ctx, agent, session } = harness(stored.surface, new Map(stored.events.map(event => [event.seq, event])))

  runCommand(ctx, agent, '3')
  await claimedStep(ctx, agent, [HUMAN_PROMPT], 2)

  const readBack = materializeSend(stored.events, onlyMessageAppend(session))
  assert.doesNotThrow(
    () => { assertReleasedV4Relationships({ header: HEADER, events: readBack, inheritedEventCount: 0 } as never, KNOWN_TYPES) },
    'the host refused the log the plugin wrote',
  )
})
