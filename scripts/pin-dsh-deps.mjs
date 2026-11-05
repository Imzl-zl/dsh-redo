/**
 * Pin every `@deepseek-ai/dsh*` dev dependency (and cordis) to one DSH release.
 *
 * The plugin declares a compatibility range in `engines.dsh`, and a range is
 * only worth what someone has actually run. This script is the mechanism behind
 * that claim: it rewrites the type-check target to one exact release so the
 * same source can be checked against each end of the declared range.
 *
 * DSH ships its own vendored cordis, and the pairing is fixed, so both move
 * together: 0.2.0-rc.1 → 4.0.4, 0.2.1-rc.5 → 4.0.5, 0.2.2-rc.1 → 4.1.0.
 *
 * It mutates `package.json` on purpose — that is the point of a pin. Locally,
 * restore afterwards with `git checkout package.json package-lock.json`.
 *
 * usage: node scripts/pin-dsh-deps.mjs <dsh-version> <cordis-version>
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [dshVersion, cordisVersion] = process.argv.slice(2)
if (dshVersion === undefined || cordisVersion === undefined) {
  throw new Error('usage: node scripts/pin-dsh-deps.mjs <dsh-version> <cordis-version>')
}

const path = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(path, 'utf8'))
const pinned = []

for (const [name, current] of Object.entries(manifest.devDependencies ?? {})) {
  if (name === '@deepseek-ai/cordis') {
    manifest.devDependencies[name] = cordisVersion
    pinned.push(`${name} ${current} -> ${cordisVersion}`)
  } else if (name.startsWith('@deepseek-ai/dsh')) {
    manifest.devDependencies[name] = dshVersion
    pinned.push(`${name} ${current} -> ${dshVersion}`)
  }
}

if (pinned.length === 0) throw new Error('no @deepseek-ai dev dependencies found to pin')

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`pinned ${String(pinned.length)} dev dependencies to dsh ${dshVersion} / cordis ${cordisVersion}`)
for (const line of pinned) console.log(`  ${line}`)
