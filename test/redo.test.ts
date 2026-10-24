/**
 * Regression net for the host half.
 *
 * A rewind is a single `system/message` append that must simultaneously: land
 * in the open turn+step (a mismatch corrupts the JSONL on the next cold read),
 * shadow the whole surface tail from the target on, and cover exactly that tail
 * in `sourceEventSeqs`. Each test states one of those invariants and checks it
 * against a fake session, so a refactor that quietly widens, narrows, or
 * re-scopes the append goes red without a browser.
 *
 * The hooks are exercised through `apply(ctx)` — the same path the host uses —
 * rather than through an exported helper, so the wiring, the `/redo` command,
 * and the composer latch are covered too.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { apply } from '../src/index.ts'

/** A message source as the loop hands it to `agent/pre-step`. */
interface FakeSource {
  readonly kind: string
  readonly rpcId?: string
}

interface FakeMessage {
  readonly source: FakeSource
}

/** The one append shape the host half is allowed to make. */
interface RewindAppend {
  readonly type: string
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly message: {
      readonly id: string
      readonly role: string
      readonly content: readonly unknown[]
      readonly source: { readonly kind: string }
    }
  }
  readonly options: {
    readonly surfaceOp: { readonly op: string; readonly startSeq: number; readonly endSeq: number }
    readonly sourceEventSeqs: readonly number[]
  }
}

type Handler = (payload: unknown, next: () => Promise<void>) => unknown

/** One registered command, as the fake registry keeps it. */
interface FakeCommand {
  readonly name: string
  readonly handler: (invocation: unknown) => unknown
}

/** Minimal stand-in for the agent's session surface. */
interface FakeSession {
  readonly surface: { readonly nodes: readonly number[] }
  readonly appends: RewindAppend[]
  eventAt(seq: number): unknown
  append(type: string, data: unknown, options: unknown): void
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
function fakeSession(nodes: readonly number[], events: ReadonlyMap<number, unknown>): FakeSession {
  const appends: RewindAppend[] = []
  return {
    surface: { nodes },
    appends,
    eventAt(seq) { return events.get(seq) },
    append(type, data, options) {
      appends.push({ type, data, options } as RewindAppend)
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
function harness(nodes: readonly number[], events: ReadonlyMap<number, unknown>) {
  const ctx = fakeCtx()
  const session = fakeSession(nodes, events)
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

/** A tool-result message: the loop claims it, but no human typed it. */
const TOOL_MESSAGE: FakeMessage = { source: { kind: 'tool' } }

/** The event a real committed user message carries. */
const USER_EVENT = { type: 'user/message', data: { source: { kind: 'user' } } }

/** Narrow the single recorded append, failing loudly on zero or many. */
function onlyAppend(session: FakeSession): RewindAppend {
  assert.equal(session.appends.length, 1, 'expected exactly one append')
  const append = session.appends[0]
  assert.ok(append !== undefined)
  return append
}

test('the rewind shadows the whole surface tail in one append inside the open step', async () => {
  const nodes = [1, 4, 12, 20, 33]
  const target = 12
  const turn = 7
  const step = 2
  const events = new Map<number, unknown>([[target, USER_EVENT]])
  const { ctx, session, agent } = harness(nodes, events)

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(target)], turn, step })
  await emit(ctx, 'agent/request', { agent, turn, step })

  const append = onlyAppend(session)
  const shadowed = nodes.slice(nodes.indexOf(target))

  assert.equal(append.type, 'system/message')
  // Constraint: a message-producing append must carry the open step's exact
  // coordinates, or the next cold read rejects the log as corrupt.
  assert.equal(append.data.turn, turn)
  assert.equal(append.data.step, step)
  // Constraint: exactly one replacement, spanning the target through the tail.
  assert.deepEqual(append.options.surfaceOp, {
    op: 'replace',
    startSeq: shadowed[0],
    endSeq: shadowed.at(-1),
  })
  // Constraint: `sourceEventSeqs` covers every shadowed surface node, no more.
  assert.deepEqual([...append.options.sourceEventSeqs], shadowed)
  // The replacement must project to no model message: a system node with empty
  // content. An empty user message would be sent to the provider.
  assert.equal(append.data.message.role, 'system')
  assert.deepEqual([...append.data.message.content], [])
})

test('the replacement never takes the shape of a user message', async () => {
  const nodes = [1, 9, 17]
  const { ctx, session, agent } = harness(nodes, new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 1)
  for (const append of session.appends) {
    assert.equal(append.type, 'system/message')
    assert.notEqual(append.data.message.source.kind, 'user')
  }
})

test('each rewind mints a fresh empty node identity', async () => {
  const nodes = [1, 9, 17]
  const events = new Map<number, unknown>([[9, USER_EVENT]])
  const first = harness(nodes, events)
  await emit(first.ctx, 'agent/pre-step', { agent: first.agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(first.ctx, 'agent/request', { agent: first.agent, turn: 3, step: 1 })

  const second = harness(nodes, events)
  await emit(second.ctx, 'agent/pre-step', { agent: second.agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(second.ctx, 'agent/request', { agent: second.agent, turn: 3, step: 1 })

  assert.notEqual(
    onlyAppend(first.session).data.message.id,
    onlyAppend(second.session).data.message.id,
  )
})

test('an ordinary prompt with no arm passes through untouched', async () => {
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
    /no longer part of the active context/,
  )
})

test('the protected session head cannot be rewound', async () => {
  const nodes = [1, 9, 17]
  const { ctx, agent } = harness(nodes, new Map([[1, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(1)], turn: 3, step: 1 })

  await assert.rejects(
    emit(ctx, 'agent/request', { agent, turn: 3, step: 1 }),
    /protected session head/,
  )
})

test('a node that is not a human user message cannot be rewound', async () => {
  const assistant = { type: 'assistant/message', data: { source: { kind: 'assistant' } } }
  const { ctx, agent } = harness([1, 9, 17], new Map([[9, assistant]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })

  await assert.rejects(
    emit(ctx, 'agent/request', { agent, turn: 3, step: 1 }),
    /not a human user message/,
  )
})

test('a disposed agent drops its pending plan and its arm', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(9)], turn: 3, step: 1 })
  await emit(ctx, 'agent/disposed', { agent })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 0)

  const armed = harness([1, 9, 17], new Map([[9, USER_EVENT]]))
  assert.deepEqual(runCommand(armed.ctx, armed.agent, ' 9'), { kind: 'success' })
  await emit(armed.ctx, 'agent/disposed', { agent: armed.agent })
  await emit(armed.ctx, 'agent/pre-step', { agent: armed.agent, messages: [HUMAN_PROMPT], turn: 4, step: 1 })
  await emit(armed.ctx, 'agent/request', { agent: armed.agent, turn: 4, step: 1 })
  assert.equal(armed.session.appends.length, 0)
})

test('an armed composer rewrite turns the next human prompt into a rewind', async () => {
  const nodes = [1, 9, 17, 24]
  const target = 9
  const turn = 5
  const step = 1
  const { ctx, session, agent } = harness(nodes, new Map([[target, USER_EVENT]]))

  // The click: the client arms through the command, then refills the composer.
  assert.deepEqual(runCommand(ctx, agent, ` ${String(target)}`), { kind: 'success' })
  assert.equal(session.appends.length, 0)

  // The send: an ordinary composer prompt, with no redo request id.
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn, step })
  await emit(ctx, 'agent/request', { agent, turn, step })

  const append = onlyAppend(session)
  const shadowed = nodes.slice(nodes.indexOf(target))
  assert.equal(append.data.turn, turn)
  assert.equal(append.data.step, step)
  assert.deepEqual(append.options.surfaceOp, {
    op: 'replace',
    startSeq: shadowed[0],
    endSeq: shadowed.at(-1),
  })
  assert.deepEqual([...append.options.sourceEventSeqs], shadowed)
})

test('an arm is consumed by exactly one prompt', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })
  assert.equal(session.appends.length, 1)

  // The message after the rewrite is an ordinary one.
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 4, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 4, step: 1 })
  assert.equal(session.appends.length, 1)
})

test('a tool step does not consume the arm', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  await emit(ctx, 'agent/pre-step', { agent, messages: [TOOL_MESSAGE], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })
  assert.equal(session.appends.length, 0)

  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 3, step: 2 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 2 })
  assert.equal(session.appends.length, 1)
})

test('an expired arm is dropped instead of rewriting a later message', async (t) => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  // A day later the click no longer explains anything the human sends.
  clock += 24 * 60 * 60 * 1000
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 0)
})

test('/redo off disarms a pending rewrite', async () => {
  const { ctx, session, agent } = harness([1, 9, 17], new Map([[9, USER_EVENT]]))

  runCommand(ctx, agent, '9')
  assert.deepEqual(runCommand(ctx, agent, 'off'), { kind: 'success' })
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(session.appends.length, 0)
})

test('an explicit retry outranks an armed rewrite and clears it', async () => {
  const nodes = [1, 9, 17, 24, 31]
  const events = new Map<number, unknown>([[17, USER_EVENT], [31, USER_EVENT]])
  const { ctx, session, agent } = harness(nodes, events)

  runCommand(ctx, agent, '9')
  await emit(ctx, 'agent/pre-step', { agent, messages: [redoMessage(17)], turn: 3, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 3, step: 1 })

  assert.equal(onlyAppend(session).options.surfaceOp.startSeq, 17)

  // The arm must be gone: the next ordinary prompt is an ordinary prompt.
  await emit(ctx, 'agent/pre-step', { agent, messages: [HUMAN_PROMPT], turn: 4, step: 1 })
  await emit(ctx, 'agent/request', { agent, turn: 4, step: 1 })
  assert.equal(session.appends.length, 1)
})

test('the command refuses what the rewind would refuse, and bad arguments', async () => {
  const assistant = { type: 'assistant/message', data: { source: { kind: 'assistant' } } }
  const events = new Map<number, unknown>([[1, USER_EVENT], [9, assistant], [17, USER_EVENT]])
  const { ctx, agent } = harness([1, 9, 17], events)

  for (const rawInput of ['', 'abc', '0x10', '9.5', '-3']) {
    const result = runCommand(ctx, agent, rawInput) as { kind: string }
    assert.equal(result.kind, 'error', `accepted ${JSON.stringify(rawInput)}`)
  }
  for (const rawInput of ['42', '1', '9']) {
    const result = runCommand(ctx, agent, rawInput) as { kind: string }
    assert.equal(result.kind, 'error', `accepted ${rawInput}`)
  }
  // A valid target still arms after those refusals.
  assert.deepEqual(runCommand(ctx, agent, '17'), { kind: 'success' })
})
