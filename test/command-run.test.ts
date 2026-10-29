/**
 * Regression net for the composer-deciding half of an edit click.
 *
 * The click is only honest when the Host actually rewrote the surface. Two
 * shapes have to be told apart, and the difference is invisible to
 * `Session.command()`:
 *
 * - the handler succeeded → a replacement is in the log → refill the composer;
 * - the handler refused (`busy` while a Turn is open, `missing` once the target
 *   left the context, `head`, `not-user`) → the log is untouched → the composer
 *   must stay exactly as it was.
 *
 * The last two tests drive the **real** `/redo` handler and feed its own result
 * to the classifier, so "a refusal can never read as success" is asserted
 * against the production refusal text rather than a re-typed constant.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { apply } from '../src/index.ts'
import { classifyCommandRun } from '../src/client/command-run.ts'

// ---------------------------------------------------------------------------
// The mapping itself
// ---------------------------------------------------------------------------

test('a successful handler is the only shape that refills the composer', () => {
  assert.deepEqual(classifyCommandRun({ ok: true, value: { result: { kind: 'success' } } }), { ok: true })
})

test('a handler refusal is reported with the host text it came with', () => {
  const text = 'redo: the session is still generating; retract once the turn has ended'
  assert.deepEqual(
    classifyCommandRun({ ok: true, value: { result: { kind: 'error', text } } }),
    { ok: false, code: 'rejected', message: text },
  )
})

test('an unmatched command is a miss, not a refusal', () => {
  assert.deepEqual(classifyCommandRun({ ok: true, value: undefined }), { ok: false, code: 'command' })
})

test('a transport failure carries the RPC message', () => {
  assert.deepEqual(
    classifyCommandRun({ ok: false, error: { message: 'carrier stopped' } }),
    { ok: false, code: 'rejected', message: 'carrier stopped' },
  )
})

// ---------------------------------------------------------------------------
// The bridge: the real /redo handler's own result
// ---------------------------------------------------------------------------

/** Minimal stand-in for the agent's session: only what `/redo` touches. */
function fakeSession(nodes: readonly number[], events: ReadonlyMap<number, unknown>) {
  const appends: string[] = []
  return {
    appends,
    surface: { nodes },
    eventAt(seq: number) { return events.get(seq) },
    append(type: string) { appends.push(type) },
  }
}

/**
 * Run the real `/redo` handler once against a session whose surface holds
 * `nodes` (after the optional `mutate`).
 * @param mutate - rewrite the surface before the click, as another window would.
 * @returns the handler's normalized result, untouched.
 */
function runRedoUntilSettled(mutate?: (nodes: number[]) => void): { kind: string, text?: string } {
  const registered = new Map<string, { handler: (invocation: unknown) => unknown }>()
  const ctx = {
    commands: { register: (command: never) => { registered.set((command as { name: string }).name, command as never); return () => {} } },
    on: () => () => {},
    effect: (factory: () => unknown) => { factory() },
  }
  apply(ctx as unknown as Context)

  const command = registered.get('redo')
  assert.ok(command !== undefined, 'the /redo command was not registered')
  const nodes = [1, 9]
  mutate?.(nodes)
  const session = fakeSession(nodes, new Map([[9, { type: 'user/message', data: { source: { kind: 'user' } } }]]))
  return command.handler({
    agent: { session },
    rawInput: '9',
    commandId: 'test',
    attachments: [],
    signal: new AbortController().signal,
  }) as { kind: string, text?: string }
}

test("the plugin's own refusal never reaches the composer as success", () => {
  // The target left the context (another window rewrote the session): the Host
  // refuses the arm, and the composer must stay exactly as it was.
  const result = runRedoUntilSettled(nodes => { nodes.splice(1, 1) })

  assert.equal(result.kind, 'error', 'the host must refuse a target that left the context')
  const verdict = classifyCommandRun({ ok: true, value: { result } as never })
  assert.equal(verdict.ok, false, 'a refusal must never refill the composer')
  assert.equal(verdict.ok === false && verdict.message, result.text)
})

test('a legal target settles as success', () => {
  const result = runRedoUntilSettled()

  assert.equal(result.kind, 'success')
  assert.deepEqual(classifyCommandRun({ ok: true, value: { result } as never }), { ok: true })
})
