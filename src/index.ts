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
 * Turn boundaries belong to the host, and this plugin reads them from the very
 * fold the loop and the log reader use (`turnBoundary`): a `turn/start` opens a
 * Turn only in a closed log, and only with the number that follows the last one.
 * So a retraction is offered **between** Turns and refused inside one, and the
 * Turn it opens is numbered by that same projection rather than by a scan of the
 * log — the loop's next Turn then takes the number after this one, which is the
 * only way a later cold read can still accept the log.
 *
 * @module dsh-redo
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, TurnBoundaryProjection } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
// Service-and-map augmentation only: `ctx.sessionProjections` and the
// `turnBoundary` entry this plugin reads are declared there, not here.
import type {} from '@deepseek-ai/dsh-session-projection'

export const name = 'redo'
export const inject = ['agents', 'commands', 'sessionProjections']

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

/**
 * Why a retraction cannot be written right now.
 *
 * `busy` is not a client-visible nicety: a Turn that is still open owns the
 * Step the loop is writing into, and opening another Turn behind it is the one
 * thing a cold read refuses (`turn/start does not open the expected turn`).
 */
type Refusal = 'missing' | 'head' | 'not-user' | 'busy'

/** Host-facing text for one refusal, shared by both entry points. */
const REFUSAL: Record<Refusal, string> = {
  missing: 'that message is no longer part of the conversation context',
  head: 'the first message of a session cannot be rewritten',
  'not-user': 'only a message you sent can be rewritten',
  busy: 'the session is still generating; retract once the turn has ended',
}

/** Everything one retraction writes, read in a single pass. */
interface Retraction {
  /** Turn the retraction opens: the host's next turn number. */
  readonly turn: number
  /** Surface nodes the replacement shadows: the target through the current tail. */
  readonly shadowed: SessionSeq[]
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
 * Whether `target` is a message this plugin may rewrite at all.
 * @param agent - agent whose session surface is inspected.
 * @param target - session seq the human asked to redo.
 * @returns the refusal, or undefined when the target itself is rewritable.
 */
function targetRefusal(agent: Agent, target: number): Refusal | undefined {
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
 * Read the host's turn boundary fold.
 *
 * Every DSH composition that can run an agent registers `turnBoundary`; a
 * missing fold means this is not a host this plugin can write a Turn into, so
 * say so instead of guessing a number.
 *
 * @param ctx - host context carrying the projection registry.
 * @param agent - agent whose session boundary is read.
 * @returns the open turn (null between turns) and the last turn number.
 * @throws when the `turnBoundary` projection is not registered.
 */
function boundaryOf(ctx: Context, agent: Agent): TurnBoundaryProjection {
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')
  if (boundary === undefined) throw new Error('redo: the host exposes no turnBoundary projection')
  return boundary
}

/**
 * Decide whether a retraction can be written now, and what it would write.
 * @param ctx - host context carrying the projection registry.
 * @param agent - agent whose session is inspected.
 * @param target - session seq the human asked to retract.
 * @returns the retraction to write, or why it cannot be written.
 */
function planRetraction(ctx: Context, agent: Agent, target: number): Retraction | Refusal {
  const why = targetRefusal(agent, target)
  if (why !== undefined) return why
  const boundary = boundaryOf(ctx, agent)
  // A Turn that is still open owns its Step; a second `turn/start` there is the
  // corruption this guard exists to prevent.
  if (boundary.openTurnStartSeq !== null) return 'busy'
  return { turn: boundary.lastTurn + 1, shadowed: shadowedFrom(agent, target) }
}

/**
 * Append the replacement inside an open turn+step.
 *
 * The replacement is an empty `system/message`: an empty system, developer, or
 * assistant node projects to no model message, and the Chat target hides a
 * system node that entered by replacement. A user message cannot be used — it
 * always projects, so the model would receive an empty user turn.
 *
 * @param agent - agent whose session surface is rewritten.
 * @param shadowed - surface nodes the replacement shadows, oldest first.
 * @param turn - open turn that owns this append.
 * @param step - open step that owns this append.
 */
function appendReplacement(agent: Agent, shadowed: readonly SessionSeq[], turn: number, step: number): void {
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
    sourceEventSeqs: [...shadowed],
  })
}

/**
 * Write the retraction the plan describes, opening and closing its Turn.
 *
 * No Step is requested beyond the one the replacement needs, so the loop never
 * calls a model for this Turn.
 *
 * @param agent - agent whose session is rewritten.
 * @param plan - turn number and shadowed nodes, already decided.
 */
function retract(agent: Agent, plan: Retraction): void {
  agent.session.append('turn/start', { turn: plan.turn })
  agent.session.append('step/start', { turn: plan.turn, step: 1 })
  appendReplacement(agent, plan.shadowed, plan.turn, 1)
  agent.session.append('step/end', { turn: plan.turn, step: 1 })
  agent.session.append('turn/end', { turn: plan.turn, reason: { kind: 'completed' } })
}

/**
 * Rewind the context inside the Step that is already open — the retry path.
 *
 * Here the host owns the boundaries: `turn` and `step` come from the hook, so
 * only the replacement is this plugin's to write.
 *
 * @param agent - agent whose session surface is rewritten.
 * @param target - seq of the user message to drop, together with the tail.
 * @param turn - open turn that owns this append.
 * @param step - open step that owns this append.
 * @throws when the target is no longer part of the active context, or is not a
 *   human user message.
 */
function rewind(agent: Agent, target: number, turn: number, step: number): void {
  const why = targetRefusal(agent, target)
  if (why !== undefined) throw new Error(`redo: ${REFUSAL[why]}`)
  appendReplacement(agent, shadowedFrom(agent, target), turn, step)
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
 * @param ctx - host context carrying the agent registry, command registry, and
 *   the session projections this plugin reads turn boundaries from.
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
      const plan = planRetraction(ctx, invocation.agent, parsed)
      if (typeof plan === 'string') return { kind: 'error', text: `redo: ${REFUSAL[plan]}` }
      try {
        retract(invocation.agent, plan)
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
