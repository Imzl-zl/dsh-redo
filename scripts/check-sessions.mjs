/**
 * Read stored session logs the way a GUI history load does and report what the
 * host refuses. Accepts one log file or a directory tree of them.
 *
 * usage: node scripts/check-sessions.mjs <path> [more paths...]
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assertReleasedV4Relationships } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { readSession } from './read-session.mjs'

const targets = []
const collect = (path) => {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) collect(join(path, entry.name))
    return
  }
  if (/\.jsonl\.zstd$/u.test(path)) targets.push(path)
}

const roots = process.argv.slice(2)
if (roots.length === 0) throw new Error('usage: node scripts/check-sessions.mjs <path> [more paths...]')
for (const root of roots) collect(root)

/** Name the first event whose prefix the reader refuses. */
function firstBadEvent({ header, events }, known) {
  let low = 0
  let high = events.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    try {
      assertReleasedV4Relationships({ header, events: events.slice(0, mid), inheritedEventCount: 0 }, known)
      low = mid + 1
    } catch {
      high = mid
    }
  }
  return events[low - 1]
}

let failed = 0
for (const path of targets) {
  let decoded
  try {
    decoded = readSession(path)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${path}\n      decode: ${error.message}`)
    continue
  }
  const { header, events } = decoded
  const { type: _logTag, ...logicalHeader } = header
  const known = new Set(events.map(event => event.type))
  try {
    assertReleasedV4Relationships({ header: logicalHeader, events, inheritedEventCount: 0 }, known)
    console.log(`OK    ${path}  events=${events.length}`)
  } catch (error) {
    failed += 1
    const bad = firstBadEvent({ header: logicalHeader, events }, known)
    console.log(`FAIL  ${path}  events=${events.length}`)
    console.log(`      ${error.message}`)
    console.log(`      first bad event seq=${bad?.seq} type=${bad?.type} data=${JSON.stringify(bad?.data).slice(0, 200)}`)
  }
}

console.log(`\nchecked ${targets.length} logs, ${failed} refused`)
if (failed > 0) process.exitCode = 1
