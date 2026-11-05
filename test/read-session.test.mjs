/**
 * Regression net for the session-log reader.
 *
 * A v4 log stores `sourceEventSeqs` range-encoded: a consecutive run collapses
 * to a `[start, end]` pair, and the format codec expands it on every real read.
 * A reader that skips that step sees `[[8,12],17]` and reports a complete
 * citation list as a truncated one — which is exactly how `check-sessions.mjs`
 * came to refuse a healthy session written by DSH 0.2.1-rc.5.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeSources } from '../scripts/read-session.mjs'

test('a range-encoded citation list expands to every seq it stands for', () => {
  const stored = { seq: 27, type: 'system/message', sourceEventSeqs: [[8, 12], 17] }
  assert.deepEqual(decodeSources(stored).sourceEventSeqs, [8, 9, 10, 11, 12, 17])
})

test('a flat citation list is already logical and stays as written', () => {
  const stored = { seq: 9, type: 'system/message', sourceEventSeqs: [3, 4] }
  assert.deepEqual(decodeSources(stored).sourceEventSeqs, [3, 4])
})

test('an event without citations is returned untouched', () => {
  const event = { seq: 5, type: 'turn/start', data: {} }
  assert.equal(decodeSources(event), event)
})

test('a malformed citation list names the event that carries it', () => {
  const stored = { seq: 12, type: 'system/message', sourceEventSeqs: [[4, 2]] }
  assert.throws(() => decodeSources(stored), /event seq 12/)
})
