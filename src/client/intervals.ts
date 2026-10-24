/**
 * Shadowed intervals, derived from the Session's own event window.
 *
 * A rewind is a `surfaceOp: { op: 'replace', startSeq, endSeq }` append, so the
 * interval it removed is durable — the client does not have to remember which
 * messages a redo replaced. Reading it back from the log is what lets a reload
 * keep the rewind hidden: the earlier in-memory registry lost the interval on
 * every refresh, and an in-memory-only hide would resurrect the replaced
 * message on the next load.
 *
 * Only the envelope fields the derivation needs are named here, so a test can
 * feed plain objects and the caller can pass `SessionEvent`s unchanged.
 *
 * @module dsh-redo/client/intervals
 */

/** One interval a surface replacement removed from the conversation. */
export interface SupersededInterval {
  /** First shadowed seq, inclusive. */
  readonly from: number
  /** Last shadowed seq, inclusive. */
  readonly to: number
}

/** The event facts this derivation reads. */
export interface SurfaceEventLike {
  /** Durable session seq. */
  readonly seq: number
  /** Event type; only `surfaceOp` matters here. */
  readonly type: string
  /** Event payload; only turn boundaries read it. */
  readonly data?: unknown
  /** Surface marker, `'append'` or `{ op: 'replace', startSeq, endSeq }`. */
  readonly surfaceOp?: unknown
}

/**
 * Read a replace operation off one event's surface marker.
 * @param op - the raw `surfaceOp` value.
 * @returns the replaced range, or undefined for an append or a malformed marker.
 */
function replaceRangeOf(op: unknown): SupersededInterval | undefined {
  if (typeof op !== 'object' || op === null) return undefined
  const record = op as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (record.op !== 'replace') return undefined
  const { startSeq, endSeq } = record
  if (typeof startSeq !== 'number' || typeof endSeq !== 'number') return undefined
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return undefined
  // An inverted range is not a rewind; the host rejects it, so ignore it here
  // rather than hiding a stretch of history nobody rewound.
  if (endSeq < startSeq) return undefined
  return { from: startSeq, to: endSeq }
}

/**
 * Whether a seq was removed from the conversation by a rewind.
 * @param intervals - the Session's derived intervals.
 * @param seq - message seq to test.
 * @returns true when the seq sits inside one of the intervals.
 */
export function covers(intervals: readonly SupersededInterval[], seq: number): boolean {
  return intervals.some(interval => seq >= interval.from && seq <= interval.to)
}

/**
 * Collect the intervals one session's loaded events say were replaced.
 *
 * Overlapping replacements are kept apart on purpose: a second rewind shadows
 * the replacement message of the first, and both intervals stay meaningful for
 * the interval test.
 *
 * @param events - loaded session events, oldest first.
 * @returns the shadowed intervals; empty when the window holds no replacement.
 */
export function deriveIntervals(events: readonly SurfaceEventLike[]): readonly SupersededInterval[] {
  const intervals: SupersededInterval[] = []
  for (const event of events) {
    const range = replaceRangeOf(event.surfaceOp)
    if (range !== undefined) intervals.push(range)
  }
  return intervals
}

/**
 * Read the turn number out of a turn boundary event.
 * @param event - one event.
 * @returns the turn number, or undefined when the event is not a boundary.
 */
function turnOf(event: SurfaceEventLike): number | undefined {
  if (event.type !== 'turn/start' && event.type !== 'turn/end') return undefined
  const value = (event.data as { turn?: unknown } | undefined)?.turn
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Turns that exist only to carry a retraction.
 *
 * A retraction needs an open turn+step to hold its `system/message`, so the Host
 * opens one that carries nothing else. The Chat flow still renders that turn's
 * process row and usage tail, which would leave an empty 「已完成」 line above the
 * replacement. A turn with a replacement but no human message is exactly that
 * turn — no prompt ever reaches the model for it.
 *
 * @param events - loaded session events, oldest first.
 * @returns the turn numbers to hide; empty when none exist.
 */
export function deriveRetractionTurns(events: readonly SurfaceEventLike[]): readonly number[] {
  const prompted = new Set<number>()
  const replaced = new Set<number>()
  let turn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = turnOf(event)
      continue
    }
    if (event.type === 'turn/end') {
      turn = undefined
      continue
    }
    if (turn === undefined) continue
    if (event.type === 'user/message') prompted.add(turn)
    else if (replaceRangeOf(event.surfaceOp) !== undefined) replaced.add(turn)
  }
  return [...replaced].filter(value => !prompted.has(value))
}
