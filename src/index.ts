/**
 * dsh-redo — host half.
 *
 * Rewrites the model context in place from a chosen user message. Two entry
 * points, one append each:
 *
 * - **Retract (edit).** The client sends `/redo <seq>`, and the command rewinds
 *   the context immediately: it opens a Turn, appends the replacement inside
 *   that Turn's only Step, and closes both. Nothing waits for the next send, so
 *   the message is gone from the model context the moment the human clicks —
 *   which is what a retraction means.
 * - **Retry.** The client sends an ordinary prompt whose request id carries
 *   `redo:<target>:<uuid>`, so `agent/pre-step` recognises the rewind from the
 *   message the loop just claimed, and `agent/request` writes it inside the open
 *   Step.
 *
 * The session is append-only, so nothing is deleted — one surface replacement
 * shadows the old message and everything the turns after it produced, and the
 * replacement node itself projects to no model message.
 *
 * Why the command opens its own Turn: a `system/message` may only be appended
 * inside an open turn+step with exact coordinates, or a later JSONL read rejects
 * the log as corrupt. A click happens between Turns, so the command opens one
 * that carries nothing but the replacement. No Step is requested, so no model
 * call happens.
 *
 * @module dsh-redo
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

export const name = 'redo'
export const inject = ['agents', 'commands']

/** Prefix the client writes into the prompt request id of a retry. */
const REDO_PREFIX = 'redo:'

/**
 * The target seq as the client mints it: digits, then the uuid fence.
 *
 * Digits only on purpose. `Number()` would accept `''` as 0, `'0x10'` as 16,
 * and `'1e3'` as 1000, so a malformed request id could name a seq the human
 * never asked for — and 0 is the protected session head, which turns a junk
 * id into a host error instead of a no-op.
 */
const REDO_REQUEST_ID = /^(\d+):/

/** What the `/redo` command accepts. */
const USAGE = '/redo <message seq>'

/** One pending retry, recorded at pre-step and consumed at request. */
interface RedoPlan {
  readonly turn: number
  readonly step: number
  /** Session seq of the user message the human asked to redo. */
  readonly target: number
}

/** Why a target cannot be rewound. */
type TargetRefusal = 'missing' | 'head' | 'not-user'

/** Host-facing text for one refusal, thrown into the turn. */
const REFUSAL_THROWN: Record<TargetRefusal, string> = {
  missing: 'is no longer part of the active context',
  head: 'is the protected session head',
  'not-user': 'is not a human user message',
}

/** Human-facing text for one refusal, returned as the command result. */
const REFUSAL_SHOWN: Record<TargetRefusal, string> = {
  missing: 'that message is no longer part of the conversation context',
  head: 'the first message of a session cannot be rewritten',
  'not-user': 'only a message you sent can be rewritten',
}

/**
 * Read the redo target out of a message source.
 * @param source - the claimed message's producer source.
 * @returns the target seq, or undefined for an ordinary prompt.
 */
function redoTarget(source: unknown): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as { kind?: unknown; rpcId?: unknown }
  if (record.kind !== 'user' || typeof record.rpcId !== 'string') return undefined
  if (!record.rpcId.startsWith(REDO_PREFIX)) return undefined
  const match = REDO_REQUEST_ID.exec(record.rpcId.slice(REDO_PREFIX.length))
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Whether `target` can be rewritten right now.
 * @param agent - agent whose session surface is inspected.
 * @param target - session seq the human asked to redo.
 * @returns the refusal, or undefined when the rewind is legal.
 */
function refusalOf(agent: Agent, target: number): TargetRefusal | undefined {
  const session = agent.session
  const nodes = [...session.surface.nodes]
  const start = nodes.indexOf(target as SessionSeq)
  if (start < 0) return 'missing'
  if (start === 0) return 'head'
  // Existing-history read: the owning turn already committed this message, and
  // the sync reader is the only accessor available from an agent scope here.
  // oxlint-disable-next-line typescript/no-deprecated -- guarded legacy history read
  const event = session.eventAt(target as SessionSeq)
  if (event?.type !== 'user/message' || event.data.source.kind !== 'user') return 'not-user'
  return undefined
}

/**
 * The surface nodes from `target` to the current tail, oldest first.
 * @param agent - agent whose session surface is inspected.
 * @param target - first node to shadow.
 * @returns the shadowed nodes, which also become `sourceEventSeqs`.
 */
function shadowedFrom(agent: Agent, target: number): SessionSeq[] {
  const nodes = [...agent.session.surface.nodes]
  return nodes.slice(nodes.indexOf(target as SessionSeq))
}

/**
 * Append the replacement inside the open turn+step.
 *
 * The replacement is an empty `system/message`: an empty system, developer, or
 * assistant node projects to no model message, and the Chat target hides a
 * system node that entered by replacement. A user message cannot be used — it
 * always projects, so the model would receive an empty user turn.
 *
 * @param agent - agent whose session surface is rewritten.
 * @param target - seq of the user message to drop, together with the tail.
 * @param turn - open turn that owns this append.
 * @param step - open step that owns this append.
 * @throws when the target is no longer part of the active context, or is not a
 *   human user message.
 */
function rewind(agent: Agent, target: number, turn: number, step: number): void {
  const why = refusalOf(agent, target)
  if (why !== undefined) throw new Error(`redo: message ${target} ${REFUSAL_THROWN[why]}`)
  const shadowed = shadowedFrom(agent, target)
  agent.session.append('system/message', {
    turn,
    step,
    message: {
      // A fresh identity keeps the empty node unique; it never reaches a provider.
      id: randomUUID() as never,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [],
    },
  }, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0] as SessionSeq, endSeq: shadowed[shadowed.length - 1] as SessionSeq },
    sourceEventSeqs: shadowed,
  })
}

/**
 * Read the highest turn the log has opened.
 * @param agent - agent whose session log is read.
 * @returns the last turn number, or 0 before the first turn.
 */
function latestTurn(agent: Agent): number {
  let turn = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    const value = (event.data as { turn?: unknown }).turn
    if (typeof value === 'number' && value > turn) turn = value
  }
  return turn
}

/**
 * Rewind the context now, opening and closing the Turn that carries it.
 *
 * A retraction is a transcript fact, not a queued intention: the human clicked,
 * so the message leaves the model context immediately. No Step is requested, so
 * the loop never calls a model for this Turn.
 *
 * @param agent - agent whose session is rewritten.
 * @param target - seq of the user message to drop, together with the tail.
 * @throws when the target cannot be rewound, or when the session refuses the
 *   turn+step coordinates.
 */
function retract(agent: Agent, target: number): void {
  const why = refusalOf(agent, target)
  if (why !== undefined) throw new Error(`redo: message ${target} ${REFUSAL_THROWN[why]}`)
  const shadowed = shadowedFrom(agent, target)
  const turn = latestTurn(agent) + 1
  agent.session.append('turn/start', { turn })
  agent.session.append('step/start', { turn, step: 1 })
  agent.session.append('system/message', {
    turn,
    step: 1,
    message: {
      id: randomUUID() as never,
      role: 'system',
      source: { kind: 'system-prompt' },
      content: [],
    },
  }, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0] as SessionSeq, endSeq: shadowed[shadowed.length - 1] as SessionSeq },
    sourceEventSeqs: shadowed,
  })
  agent.session.append('step/end', { turn, step: 1 })
  agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/**
 * Parse the `/redo` argument.
 * @param rawInput - command text after the verb, verbatim.
 * @returns the target seq, or undefined when malformed.
 */
function parseTarget(rawInput: string): number | undefined {
  const trimmed = rawInput.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Install the redo hooks and the retract command.
 * @param ctx - host context carrying the agent registry and the command registry.
 */
export function apply(ctx: Context): void {
  const plans = new WeakMap<Agent, RedoPlan>()

  // The client half calls this when the human clicks 编辑重发: the retraction is
  // written here and now, which is the only way the message can leave the model
  // context without waiting for the next send.
  ctx.effect(() => ctx.commands.register({
    name: 'redo',
    description: 'Retract a sent message: it leaves the conversation now, and its content goes back to the composer',
    input: { hint: '<message seq>' },
    handler: (invocation: CommandInvocation): CommandResult => {
      const parsed = parseTarget(invocation.rawInput)
      if (parsed === undefined) return { kind: 'error', text: `redo: usage ${USAGE}` }
      const why = refusalOf(invocation.agent, parsed)
      if (why !== undefined) return { kind: 'error', text: `redo: ${REFUSAL_SHOWN[why]}` }
      try {
        retract(invocation.agent, parsed)
        return { kind: 'success' }
      } catch (thrown) {
        return { kind: 'error', text: thrown instanceof Error ? thrown.message : String(thrown) }
      }
    },
  }), 'dsh-redo: redo command')

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
    const explicit = messages
      .map(message => redoTarget(message.source))
      .find(target => target !== undefined)
    if (explicit !== undefined) plans.set(agent, { turn, step, target: explicit })
    return next()
  })

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const plan = plans.get(agent)
    if (plan !== undefined && plan.turn === turn && plan.step === step) {
      plans.delete(agent)
      rewind(agent, plan.target, turn, step)
    }
    return next()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    plans.delete(agent)
  })
}
