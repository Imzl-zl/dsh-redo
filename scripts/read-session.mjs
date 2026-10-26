/** Decode one v4 session log to JSON rows (header + events). */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]

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
  return { header: rows[0], events: rows.slice(1) }
}

if (process.argv[1]?.endsWith('read-session.mjs')) {
  if (file === undefined) throw new Error('usage: node read-session.mjs <session.v4.jsonl.zstd>')
  const { header, events } = readSession(file)
  console.log(JSON.stringify(header, null, 2))
  console.log(`events=${events.length}`)
}
