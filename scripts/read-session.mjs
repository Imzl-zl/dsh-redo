/**
 * Decode one v4 session log to JSON rows (header + events).
 *
 * Stored `sourceEventSeqs` are range-encoded — consecutive runs collapse to a
 * `[start, end]` pair — and the format codec decodes them on every real read
 * (`session-format-v0-to-v1/src/codec.ts`). Anything that parses the JSONL
 * directly must do the same, or a complete citation list reads as a truncated
 * one: `[[8,12],17]` is the run 8..12 plus 17, not the three seqs 8, 12, 17.
 * That misreading is what made `check-sessions.mjs` refuse a healthy log.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { decodeSeqRanges } from '@deepseek-ai/dsh-session'

const file = process.argv[2]

/**
 * Replace one event's stored citation list with the seqs it stands for.
 * @param event - one decoded JSONL row.
 * @returns the event with logical `sourceEventSeqs`, or the same event when it carries none.
 */
export function decodeSources(event) {
  if (event?.sourceEventSeqs === undefined) return event
  try {
    return { ...event, sourceEventSeqs: decodeSeqRanges(event.sourceEventSeqs, event.seq) }
  } catch (error) {
    throw new Error(`event seq ${String(event.seq)}: ${error.message}`, { cause: error })
  }
}

/**
 * Read one session log.
 * @param path - `session.v4.jsonl.zstd` file.
 * @returns the header row and every event, with citations already decoded.
 */
export function readSession(path) {
  const raw = readFileSync(path)
  const offsets = []
  for (let index = 0; index + 3 < raw.length; index += 1) {
    if (raw[index] === 0x28 && raw[index + 1] === 0xB5 && raw[index + 2] === 0x2F && raw[index + 3] === 0xFD) offsets.push(index)
  }
  offsets.push(raw.length)
  const chunks = []
  for (let start = 0; start < raw.length;) {
    let decoded
    let end = start
    for (const candidate of offsets) {
      if (candidate <= start) continue
      try {
        decoded = zstdDecompressSync(raw.subarray(start, candidate))
        end = candidate
        break
      } catch {
        continue
      }
    }
    if (decoded === undefined) throw new Error(`undecodable zstd frame at offset ${start}`)
    chunks.push(decoded)
    start = end
  }
  const rows = Buffer.concat(chunks).toString('utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
  return { header: rows[0], events: rows.slice(1).map(decodeSources) }
}

if (process.argv[1]?.endsWith('read-session.mjs')) {
  if (file === undefined) throw new Error('usage: node read-session.mjs <session.v4.jsonl.zstd>')
  const { header, events } = readSession(file)
  console.log(JSON.stringify(header, null, 2))
  console.log(`events=${events.length}`)
}
