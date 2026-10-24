/** Decode one v4 session log and print the event shape this plugin cares about. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node dump-session.mjs <session.v4.jsonl.zstd> [--json]')

const raw = readFileSync(file)

/** Offsets of the zstd frame magic; one append batch is one frame. */
function frameOffsets(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === 0x28 && buffer[index + 1] === 0xB5 && buffer[index + 2] === 0x2F && buffer[index + 3] === 0xFD) {
      offsets.push(index)
    }
  }
  return offsets
}

const offsets = [...frameOffsets(raw), raw.length]
const chunks = []
// Walk frames; a magic sequence can occur inside compressed bytes, so extend the
// candidate end until the slice decodes.
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
const text = Buffer.concat(chunks).toString('utf8')

const rows = text.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line))
const header = rows[0]
const events = rows.slice(1)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(events, null, 2))
  process.exit(0)
}

const preview = value => {
  const parts = []
  for (const block of value?.content ?? []) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(`<${block.type}>`)
  }
  const joined = parts.join('')
  return JSON.stringify(joined.length > 60 ? `${joined.slice(0, 60)}…` : joined)
}

console.log(`session ${header.id}  cwd=${header.cwd ?? ''}  events=${events.length}`)
for (const event of events) {
  const bits = [`${String(event.seq).padStart(3)} ${event.type}`]
  if (event.surfaceOp !== undefined) {
    bits.push(typeof event.surfaceOp === 'string'
      ? event.surfaceOp
      : `replace ${event.surfaceOp.startSeq}..${event.surfaceOp.endSeq}`)
  }
  if (event.sourceEventSeqs !== undefined) bits.push(`src=[${event.sourceEventSeqs.join(',')}]`)
  const data = event.data ?? {}
  if (event.type === 'user/message') {
    bits.push(`role=${data.role} kind=${data.source?.kind} rpc=${String(data.source?.rpcId ?? '').slice(0, 22)} ${preview(data)}`)
  } else if (event.type === 'system/message') {
    bits.push(`content=${data.message?.content?.length ?? '?'}`)
  } else if (event.type === 'assistant/message') {
    bits.push(preview(data.message))
  } else if (event.type === 'request/header') {
    bits.push(`reason=${data.reason}${data.startsSeries === true ? ' startsSeries' : ''}`)
  } else if (event.type === 'turn/start' || event.type === 'turn/end') {
    bits.push(JSON.stringify(data).slice(0, 70))
  }
  console.log(bits.join('  '))
}
