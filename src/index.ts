/**
 * dsh-redo — host half.
 *
 * Rewrites the model context in place from a chosen user message. Two entry
 * points feed it, and both end in the same append:
 *
 * - **Retry.** The client sends an ordinary prompt whose request id carries
 *   `redo:<target>:<uuid>`, so `agent/pre-step` recognises the rewind from the
 *   message the loop just claimed. Nothing else changes: the prompt text itself
 *   is the regenerated message.
 * - **Edit in the composer.** The client calls the `/redo <seq>` command, which
 *   only *arms* a target; the user then edits and sends from the composer with
 *   the identity the composer mints. The arm is a latch bound to one agent and
 *   consumed by the next claimed human prompt, within {@link ARM_TTL_MS}.
 *
 * The session is append-only, so nothing is deleted — one surface replacement
 * shadows the old message and everything the turns after it produced, and the
 * replacement node itself projects to no model message.
 *
 * **This plugin never opens a turn.** Turn numbers belong to the loop: it seeds
 * its counter from the log once, when the agent is created
 * (`agent-loop/src/index.ts:569`), then increments it privately
 * (`agent.ts:329`). A turn appended from here would not advance that counter, so
 * the loop's next turn reused the same number and the next history load refused
 * the whole session with `turn/start does not open the expected turn`. Both
 * entry points therefore write inside a turn **the loop already opened**:
 * `agent/request` runs after `step/start` and before the request is built, which
 * is the only public place where a message-producing event may legally be
 * appended with the step's coordinates.
 *
 * The armed latch is deliberately the destructive kind of state: if it is stale
 * it rewrites a message the human did not mean. {@link ARM_TTL_MS} bounds that,
 * the next human prompt consumes it, and an explicit `redo:` request id always
 * wins over it.
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

/** How long an armed composer rewrite waits for the next human prompt. */
const ARM_TTL_MS = 5 * 60 * 1000

/** What the `/redo` command accepts. */
const USAGE = '/redo <message seq>|off'

/** One pending rewind, recorded at pre-step and consumed at request. */
interface RedoPlan {
  readonly turn: number
  readonly step: number
  /** Session seq of the user message the human asked to redo. */
  readonly target: number
}

/** One armed composer rewrite, waiting for the next human prompt. */
interface ArmedTarget {
  /** Session seq the next prompt should rewrite. */
  readonly target: number
  /** Unix epoch ms of the arming click, bounded by {@link ARM_TTL_MS}. */
  readonly at: number
}

/** Why a target cannot be rewritten. */
type Refusal = 'missing' | 'head' | 'not-user'

/** Host-facing text for one refusal, thrown into the turn. */
const REFUSAL_THROWN: Record<Refusal, string> = {
  missing: 'is no longer part of the active context',
  head: 'is the protected session head',
  'not-user': 'is not a human user message',
}

/** Human-facing text for one refusal, returned as the command result. */
const REFUSAL_SHOWN: Record<Refusal, string> = {
  missing: 'that message is no longer part of the conversation context',
  head: 'the first message of a session cannot be rewritten',
  'not-user': 'only a message you sent can be rewritten',
}

/**
 * Whether one claimed message is a human prompt the composer sent.
 * @param source - the claimed message's producer source.
 * @returns true for a user prompt, which carries a client-minted request id.
 */
function isHumanPrompt(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { kind?: unknown; rpcId?: unknown }
  return record.kind === 'user' && typeof record.rpcId === 'string'
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
function refusalOf(agent: Agent, target: number): Refusal | undefined {
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
 * Rewind the model context to `target` inside the open step.
 *
 * The replacement is an empty `system/message`: an empty system, developer, or
 * assistant node projects to no model message, and the Chat target hides a
 * system node that entered by replacement. A user message cannot be used — it
 * always projects, so the model would receive an empty user turn.
 *
 * `agent/request` runs before the claimed prompt is appended, so the shadowed
 * range ends at the surface tail as it stands now: the new message, written
 * afterwards, survives and becomes the head of the context.
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
  const nodes = [...agent.session.surface.nodes]
  const shadowed = nodes.slice(nodes.indexOf(target as SessionSeq))
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
 * Parse the `/redo` argument.
 * @param rawInput - command text after the verb, verbatim.
 * @returns the armed target, `'off'` to disarm, or undefined when malformed.
 */
function parseArmTarget(rawInput: string): number | 'off' | undefined {
  const trimmed = rawInput.trim()
  if (trimmed === 'off') return 'off'
  if (!/^\d+$/u.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/**
 * Install the redo hooks and the arming command.
 * @param ctx - host context carrying the agent registry and the command registry.
 */
export function apply(ctx: Context): void {
  const plans = new WeakMap<Agent, RedoPlan>()
  const armed = new WeakMap<Agent, ArmedTarget>()

  // Programmatic arming: the client half calls this to turn the *next* composer
  // send into a rewrite, which is the only way to keep the composer native —
  // its submission request id is minted by the composer and cannot be injected.
  // Nothing is written here: a turn opened from this command would carry a
  // number the loop's own counter never sees, and its next turn would reuse it.
  ctx.effect(() => ctx.commands.register({
    name: 'redo',
    description: 'Rewrite the conversation from an earlier message: the next message you send replaces it',
    input: { hint: '<message seq>|off' },
    handler: (invocation: CommandInvocation): CommandResult => {
      const parsed = parseArmTarget(invocation.rawInput)
      if (parsed === undefined) return { kind: 'error', text: `redo: usage ${USAGE}` }
      if (parsed === 'off') {
        armed.delete(invocation.agent)
        return { kind: 'success' }
      }
      const why = refusalOf(invocation.agent, parsed)
      if (why !== undefined) return { kind: 'error', text: `redo: ${REFUSAL_SHOWN[why]}` }
      armed.set(invocation.agent, { target: parsed, at: Date.now() })
      return { kind: 'success' }
    },
  }), 'dsh-redo: redo command')

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
    const explicit = messages
      .map(message => redoTarget(message.source))
      .find(target => target !== undefined)
    if (explicit !== undefined) {
      // A retry names its own target, so it outranks anything waiting in the
      // composer — and the client that sent it expects exactly that interval.
      armed.delete(agent)
      plans.set(agent, { turn, step, target: explicit })
      return next()
    }
    const pending = armed.get(agent)
    if (pending !== undefined && messages.some(message => isHumanPrompt(message.source))) {
      // One arm, one prompt: consume it even when it has expired, so a stale
      // click cannot rewrite an unrelated message later in the session.
      armed.delete(agent)
      if (Date.now() - pending.at <= ARM_TTL_MS) plans.set(agent, { turn, step, target: pending.target })
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

  ctx.on('agent/disposed', ({ agent }) => {
    plans.delete(agent)
    armed.delete(agent)
  })
}
