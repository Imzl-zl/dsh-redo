/**
 * Build the two faces of the plugin.
 *
 * - `lib/index.js`  — Node half: plain ESM, every `@deepseek-ai/*` import kept as
 *   an import so the running installation supplies the shared instance.
 * - `lib/client.js` — browser half: CommonJS wrapped in the harness client
 *   loader handoff (`window.__ModuleLoader__.load`). Only the shell's frozen
 *   module table stays an external `require`; everything else is inlined.
 */

import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

/** Specifiers the browser shell answers from its frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  packages: 'external',
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_MODULES,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
  },
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(manifest.name)},`,
      '\tfactory: (require) => {',
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: '\t\treturn module.exports;\n\t}\n});',
  },
  logLevel: 'info',
})
