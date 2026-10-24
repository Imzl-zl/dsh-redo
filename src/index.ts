/**
 * dsh-redo — host half.
 *
 * Edits or retries a user message that has already been sent, in place: the
 * model context is rewound to just before that message, and the (edited) text
 * runs as an ordinary new turn. The session is append-only, so nothing is
 * deleted — one surface replacement shadows the old message and everything the
 * turns after it produced, and the replacement node itself projects to no
 * model message.
 *
 * The client marks its redo prompt in the request id it already owns
 * (`redo:<targetSeq>:<uuid>`), so this half needs no Remote endpoint, no
 * generated artifacts, and no host RPC.
 *
 * Two hooks, one plan:
 * - `agent/pre-step` sees the claimed messages and records which turn/step is
 *   about to become a rewind.
 * - `agent/request` runs after `step/start` and before the request is built, so
 *   it is the only public place where a message-producing event may legally be
 *   appended with the step's coordinates. Appending the replacement anywhere
 *   else (for example between turns) leaves a log that a later JSONL read
 *   rejects as corrupt.
 *
 * @module dsh-redo
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session'

export const name = 'redo'
export const inject = ['agents']

/** Prefix the client writes into the prompt request id. */
const REDO_PREFIX = 'redo:'

/** One pending rewind, recorded at pre-step and consumed at request. */
interface RedoPlan {
  readonly turn: number
  readonly step: number
  /** Session seq of the user message the human asked to redo. */
  readonly target: number
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
  const parsed = Number(record.rpcId.slice(REDO_PREFIX.length).split(':')[0])
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Rewind the model context to `target` (exclusive) inside the open step.
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
  const session = agent.session
  const nodes = [...session.surface.nodes]
  const start = nodes.indexOf(target as SessionSeq)
  if (start < 0) {
    throw new Error(`redo: message ${target} is no longer part of the active context`)
  }
  if (start === 0) {
    throw new Error(`redo: message ${target} is the protected session head`)
  }
  // Existing-history read: the owning turn already committed this message, and
  // the sync reader is the only accessor available from an agent scope here.
  // oxlint-disable-next-line typescript/no-deprecated -- guarded legacy history read
  const event = session.eventAt(target as SessionSeq)
  if (event?.type !== 'user/message' || event.data.source.kind !== 'user') {
    throw new Error(`redo: message ${target} is not a human user message`)
  }
  const shadowed = nodes.slice(start)
  session.append('system/message', {
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
 * Install the redo action on every agent.
 * @param ctx - host context carrying the agent registry.
 */
export function apply(ctx: Context): void {
  const plans = new WeakMap<Agent, RedoPlan>()

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
    for (const message of messages) {
      const target = redoTarget(message.source)
      if (target === undefined) continue
      plans.set(agent, { turn, step, target })
      break
    }
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

  ctx.on('agent/disposed', ({ agent }) => { plans.delete(agent) })
}
