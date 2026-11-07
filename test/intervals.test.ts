/**
 * Regression net for the client-side interval derivation.
 *
 * A rewound message has to leave the transcript, and the only durable record of
 * what a rewind removed is the `surfaceOp: { op: 'replace' }` marker on the
 * replacement event. These tests pin that reading: which markers count, which
 * messages they cover, and that a reload rebuilds the same answer from the log
 * alone — no client-side memory involved.
 *
 * Not every replacement is a rewind. The harness rewrites its own surface too —
 * compaction swaps an earlier span for a checkpoint, a system-prompt refresh
 * swaps the head — and those ranges contain ordinary user messages. Counting
 * every marker hid whole Turns and blanked the transcript, so a replacement
 * counts only when it is the one this plugin writes: an empty `system/message`.
 *
 * The range is inclusive on both ends on purpose. `endSeq` names the last
 * shadowed surface node, and the row for that node has to disappear too; treating
 * it as an exclusive bound would leave exactly one orphan message on screen,
 * which is the bug this whole path exists to avoid.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  covers, deriveIntervals, deriveRetractionTurns, type SurfaceEventLike,
} from '../src/client/intervals.ts'

/** One event as the client's event window hands it over. */
function at(seq: number, type: string, surfaceOp?: unknown, data?: unknown): SurfaceEventLike {
  return {
    seq,
    type,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    ...data === undefined ? {} : { data },
  }
}

/** The marker a rewind appends. */
function rewind(startSeq: number, endSeq: number) {
  return { op: 'replace', startSeq, endSeq }
}

/** The replacement payload this plugin writes: an empty system node. */
const EMPTY_SYSTEM = {
  turn: 1,
  step: 1,
  message: { id: 'replacement', role: 'system', source: { kind: 'system-prompt' }, content: [] },
}

/** The replacement this plugin writes, as a whole event. */
function rewrite(seq: number, startSeq: number, endSeq: number): SurfaceEventLike {
  return at(seq, 'system/message', rewind(startSeq, endSeq), EMPTY_SYSTEM)
}

/** A compaction checkpoint: a user node with a summary, citing an earlier span. */
function checkpoint(seq: number, startSeq: number, endSeq: number): SurfaceEventLike {
  return at(seq, 'user/message', rewind(startSeq, endSeq), {
    id: 'checkpoint',
    role: 'user',
    source: { kind: 'compact-checkpoint', compactionId: 'c' },
    content: [{ type: 'text', text: 'summary of the earlier conversation' }],
  })
}

/** A harness system-prompt refresh: a system node carrying the new prompt. */
function promptRefresh(seq: number, startSeq: number, endSeq: number): SurfaceEventLike {
  return at(seq, 'system/message', rewind(startSeq, endSeq), {
    turn: 1,
    step: 1,
    message: { id: 'prompt', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'new prompt' }] },
  })
}

test('reads the interval a rewind shadowed', () => {
  const intervals = deriveIntervals([
    at(1, 'user/message', 'append'),
    at(2, 'assistant/message', 'append'),
    rewrite(3, 1, 2),
    at(4, 'user/message', 'append'),
  ])
  assert.deepEqual(intervals, [{ from: 1, to: 2 }])
})

test('keeps every rewind in the window, including one that shadows the last replacement', () => {
  const intervals = deriveIntervals([
    at(1, 'user/message', 'append'),
    at(2, 'assistant/message', 'append'),
    rewrite(3, 1, 2),
    at(4, 'assistant/message', 'append'),
    rewrite(5, 3, 4),
  ])
  assert.deepEqual(intervals, [{ from: 1, to: 2 }, { from: 3, to: 4 }])
})

test('a compaction checkpoint over earlier messages is not a rewind', () => {
  // Compaction replaces an earlier span that holds real prompts. Hiding those
  // Turns blanked the whole transcript.
  const intervals = deriveIntervals([
    at(13, 'user/message', 'append'),
    at(22, 'assistant/message', 'append'),
    checkpoint(32, 13, 22),
  ])
  assert.deepEqual(intervals, [])
})

test('a system-prompt refresh is not a rewind', () => {
  const intervals = deriveIntervals([
    at(13, 'user/message', 'append'),
    at(22, 'assistant/message', 'append'),
    promptRefresh(32, 13, 22),
  ])
  assert.deepEqual(intervals, [])
})

test('ignores events that never shadowed anything', () => {
  const intervals = deriveIntervals([
    at(1, 'turn/start'),
    at(2, 'user/message', 'append'),
    at(3, 'assistant/message', 'append'),
    at(4, 'tool/call'),
  ])
  assert.deepEqual(intervals, [])
})

test('ignores a surface marker it cannot read as a replace', () => {
  const intervals = deriveIntervals([
    at(1, 'system/message', { op: 'append', startSeq: 0, endSeq: 0 }, EMPTY_SYSTEM),
    at(2, 'system/message', { op: 'replace' }, EMPTY_SYSTEM),
    at(3, 'system/message', { op: 'replace', startSeq: '1', endSeq: 2 }, EMPTY_SYSTEM),
    at(4, 'system/message', { op: 'replace', startSeq: 5, endSeq: 4 }, EMPTY_SYSTEM),
    at(5, 'system/message', null, EMPTY_SYSTEM),
    at(6, 'system/message', 7, EMPTY_SYSTEM),
  ])
  assert.deepEqual(intervals, [])
})

test('covers the shadowed seqs and nothing outside them', () => {
  const intervals = deriveIntervals([rewrite(3, 1, 2)])
  assert.equal(covers(intervals, 0), false)
  assert.equal(covers(intervals, 1), true)
  assert.equal(covers(intervals, 2), true)
  assert.equal(covers(intervals, 3), false)
  assert.equal(covers(intervals, 4), false)
})

test('a Turn that holds only a replacement is reported as a retraction Turn', () => {
  const events = [
    at(1, 'turn/start', undefined, { turn: 1 }),
    at(2, 'user/message', 'append'),
    at(3, 'assistant/message', 'append'),
    at(4, 'turn/end', undefined, { turn: 1 }),
    // The retraction: a Turn opened only to carry the replacement.
    at(5, 'turn/start', undefined, { turn: 2 }),
    rewrite(6, 2, 3),
    at(7, 'turn/end', undefined, { turn: 2 }),
  ]
  assert.deepEqual(deriveRetractionTurns(events), [2])
})

test('a Turn that answered a prompt is never a retraction Turn', () => {
  const events = [
    at(1, 'turn/start', undefined, { turn: 1 }),
    at(2, 'user/message', 'append'),
    rewrite(3, 1, 2),
    at(4, 'turn/end', undefined, { turn: 1 }),
  ]
  assert.deepEqual(deriveRetractionTurns(events), [])
})

test('a harness replacement never makes its Turn a retraction Turn', () => {
  const events = [
    at(1, 'turn/start', undefined, { turn: 2 }),
    checkpoint(2, 13, 22),
    at(3, 'turn/end', undefined, { turn: 2 }),
  ]
  assert.deepEqual(deriveRetractionTurns(events), [])
})

test('a replacement outside any Turn is not a retraction Turn', () => {
  const events = [rewrite(1, 1, 1)]
  assert.deepEqual(deriveRetractionTurns(events), [])
})

test('a reload rebuilds the same intervals from the window alone', () => {
  // The same event list twice: nothing is stored between the calls, so the
  // second read can only succeed if the log is the whole source of truth.
  const window = [
    at(1, 'user/message', 'append'),
    at(2, 'assistant/message', 'append'),
    rewrite(3, 1, 2),
    at(4, 'assistant/message', 'append'),
  ]
  const first = deriveIntervals(window)
  const second = deriveIntervals(window)
  assert.deepEqual(second, first)
  assert.equal(covers(second, 2), true)
})
