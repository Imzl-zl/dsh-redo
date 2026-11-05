/** Decode one v4 session log and print the event shape this plugin cares about. */
import { readSession } from './read-session.mjs'

const file = process.argv[2]
if (file === undefined) throw new Error('usage: node dump-session.mjs <session.v4.jsonl.zstd> [--json]')

// The frame walk and the range decoding live in read-session.mjs: a second copy
// here is what printed `src=[8,12,17]` for the run 8..12 plus 17.
const { header, events } = readSession(file)

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
