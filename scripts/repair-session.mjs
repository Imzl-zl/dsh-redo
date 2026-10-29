/**
 * Repair a session whose turn numbers collide.
 *
 * A third party that appended a `turn/start` between two of the loop's turns
 * (0.3.x of this plugin did exactly that) makes the loop reuse the same number.
 * The log is append-only in spirit, but a log that no reader accepts is worth
 * nothing, so this rewrites the offending turn and every later one by the same
 * offset, keeps every seq, backs the original up first, and proves the result
 * with the release validator before writing.
 *
 * usage: node scripts/repair-session.mjs <session.v4.jsonl.zstd> [--dry-run]
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node scripts/repair-session.mjs <session.v4.jsonl.zstd> [--dry-run]')
const dryRun = process.argv.includes('--dry-run')

/** One event as the log stores it; `turn` lives under `data`. */
const rows = decode(readFileSync(file))
const header = rows[0]
const events = rows.slice(1)

const problems = []
let lastClosed = 0
let open = null
let shift = 0
let shiftFrom = -1
for (const [index, event] of events.entries()) {
  const turn = event.data?.turn
  if (event.type === 'turn/start') {
    const expected = lastClosed + 1 + shift
    if (turn !== expected && shiftFrom < 0) {
      shift = expected - turn
      shiftFrom = index
      problems.push(`turn/start ${event.seq} carries turn ${turn}, expected ${expected}; shifting later turns by ${shift}`)
    }
    open = turn + shift
  } else if (event.type === 'turn/end') {
    lastClosed = turn + (shiftFrom >= 0 && index >= shiftFrom ? shift : 0)
    open = null
  } else if (typeof turn === 'number' && shiftFrom >= 0 && index >= shiftFrom) {
    // Message and step events carry the same number and move with it.
  }
}

if (shiftFrom < 0) {
  console.log('nothing to repair: every turn/start opens the expected turn')
  process.exit(0)
}
if (shift <= 0) throw new Error(`refusing to shift by ${shift}`)

for (const event of events.slice(shiftFrom)) {
  if (typeof event.data?.turn === 'number') event.data.turn += shift
}

// Prove the rewrite before touching the file: the validator is the reader.
assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, new Set(events.map(event => event.type)))

for (const problem of problems) console.log(problem)
if (dryRun) {
  console.log('dry run: the repaired log passes the release validator, nothing written')
  process.exit(0)
}

const backup = `${file}.bak-${new Date().toISOString().replaceAll(':', '-')}`
copyFileSync(file, backup)
// The container is a concatenation of independently decodable frames, and the
// reader requires the **first** frame to hold exactly the header line
// (session-persistence-jsonl: "first frame is not exactly one header line").
// So write two frames: the header alone, then every event.
const headerFrame = compress(`${JSON.stringify(header)}\n`)
const bodyFrame = compress(`${events.map(event => JSON.stringify(event)).join('\n')}\n`)
writeFileSync(file, Buffer.concat([headerFrame, bodyFrame]))
const written = readFileSync(file).subarray(0, headerFrame.length)
const headerLines = zstdDecompressSync(written).toString('utf8').split('\n').filter(line => line !== '')
if (headerLines.length !== 1) throw new Error(`first frame must hold exactly one header line, holds ${String(headerLines.length)}`)
console.log(`repaired ${String(events.length)} events; backup at ${backup}`)

/**
 * Compress one independently decodable, checksummed Zstandard frame.
 * @param text - the plaintext to encode.
 * @returns the encoded frame.
 */
function compress(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

/**
 * Split a zstd file into its append frames and concatenate the decoded text.
 * @param buffer - the raw file.
 * @returns the parsed JSON rows, header first.
 */
function decode(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xB5 && buffer[index + 2] === 0x2F && buffer[index + 3] === 0xFD) {
      offsets.push(index)
    }
  }
  offsets.push(buffer.length)
  const chunks = []
  for (let start = 0; start < buffer.length;) {
    let decoded
    let end = start
    for (const candidate of offsets) {
      if (candidate <= start) continue
      try {
        decoded = zstdDecompressSync(buffer.subarray(start, candidate))
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
  return Buffer.concat(chunks).toString('utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
}
