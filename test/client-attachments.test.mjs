/** Exercise the registered browser actions against the complete-reference image read API. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Compile the actual browser entry without mounting React. Capture its slot's
// injected actions; only the Host services and composer boundary are replaced.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/index.tsx', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  packages: 'external',
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module,
  exports: module.exports,
  require(name) {
    if (name === 'react' || name === 'react/jsx-runtime') return {}
    throw new Error(`unexpected runtime dependency: ${name}`)
  },
  File, Uint8Array, btoa, setTimeout,
  crypto: { randomUUID },
})
const { apply } = module.exports

function setup({ unreadable = false } = {}) {
  const data = Uint8Array.of(0, 1, 127, 128, 254, 255)
  const image = {
    attachmentId: `image-${randomUUID()}`,
    mediaType: 'image/png', bytes: data.length, width: 2, height: 1,
    name: 'picture.png', originalDimensions: { width: 4, height: 2 },
  }
  const calls = { reads: [], commands: [], drafts: [], prompts: [] }
  const session = {
    getSnapshot: () => ({ running: false }),
    async readAttachment(attachment) {
      calls.reads.push(attachment)
      // DSH's gateway now requires the whole ImageAttachmentRef, verifying its
      // ID, media type, byte count and dimensions against storage.
      if (unreadable || JSON.stringify(attachment) !== JSON.stringify(image)) {
        return { ok: false, error: { code: 'session/attachment-invalid', message: 'complete image reference required' } }
      }
      return { ok: true, value: { attachment, data } }
    },
    async prompt(...args) {
      calls.prompts.push(args)
      return { ok: true, value: { accepted: true } }
    },
  }
  let injected
  const sessionId = `session-${randomUUID()}`
  apply({
    effect() {},
    locale: { getLocale: () => ({ active: 'zh' }) },
    slots: {
      inject(_name, factory) { factory() },
      register(definition) { injected = definition.inject(sessionId) },
    },
    sessions: { binding: () => ({ session }) },
    conversation: {
      createDrafts(id, files, uploadImages) {
        calls.drafts.push({ id, files, uploadImages })
        return files.map((_, index) => ({ id: `draft-${index}` }))
      },
    },
    remote: { commands: {
      async execute(...args) {
        calls.commands.push(args)
        return { ok: true, value: { result: { kind: 'success' } } }
      },
    } },
  })
  assert.ok(injected, 'the production user slot must register its actions')
  return { actions: injected, calls, image, data, sessionId }
}

const options = { timeout: 60_000 }

test('editing a stored image stages its bytes and arms the rewrite', options, async () => {
  const { actions, calls, image, data, sessionId } = setup()
  const result = await actions.arm(9, [image])

  assert.equal(result.ok, true, 'a readable stored image must not report attachment failure')
  assert.equal(calls.reads[0], image, 'readAttachment receives the complete reference unchanged')
  assert.deepEqual(Array.from(result.draftIds), ['draft-0'])
  assert.equal(calls.drafts[0].id, sessionId)
  assert.equal(calls.drafts[0].uploadImages, true)
  const [file] = calls.drafts[0].files
  assert.equal(file.name, image.name)
  assert.equal(file.type, image.mediaType)
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), data)
  const [commandSession, line, attachments] = calls.commands[0]
  assert.equal(commandSession, sessionId)
  assert.equal(line, '/redo 9')
  assert.equal(attachments.length, 0)
})

test('retrying a stored image sends its bytes with the original text and metadata', options, async () => {
  const { actions, calls, image, data } = setup()
  const text = 'retry this picture'
  const result = await actions.resend(9, [
    { type: 'text', text }, { type: 'image', attachment: image },
  ])

  assert.equal(result.ok, true, 'a readable stored image must reach the prompt')
  assert.equal(calls.reads[0], image, 'retry uses the same complete-reference read API as edit')
  const [parts, mode, signal, requestId] = calls.prompts[0]
  assert.deepEqual(JSON.parse(JSON.stringify(parts)), [
    { type: 'text', text },
    { type: 'image', mediaType: image.mediaType, data: Buffer.from(data).toString('base64'), name: image.name },
  ])
  assert.equal(mode, 'queue')
  assert.equal(signal, undefined)
  assert.match(requestId, /^redo:9:[\da-f-]+$/)
})

test('an unreadable image leaves the rewrite unarmed and creates no composer drafts', options, async () => {
  const { actions, calls, image } = setup({ unreadable: true })
  const result = await actions.arm(9, [image])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'attachment')
  assert.equal(calls.commands.length, 0)
  assert.equal(calls.drafts.length, 0)
})

test('an unreadable image prevents retry from submitting partial content', options, async () => {
  const { actions, calls, image } = setup({ unreadable: true })
  const result = await actions.resend(9, [{ type: 'text', text: 'keep the image' }, { type: 'image', attachment: image }])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'attachment')
  assert.equal(calls.prompts.length, 0)
})

test('text-only edit and retry do not attempt image reads', options, async () => {
  const { actions, calls } = setup()
  assert.equal((await actions.arm(9, [])).ok, true)
  assert.equal((await actions.resend(9, [{ type: 'text', text: 'plain text' }])).ok, true)
  assert.equal(calls.reads.length, 0)
  assert.equal(calls.drafts.length, 0)
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.prompts.length, 1)
})
