/**
 * dsh-redo — browser half.
 *
 * Replaces the keyed `user` Chat node cell so one human message gains two
 * actions: retry it as-is, or edit it (text and images) and resend. Both send
 * through the ordinary prompt Remote with a `redo:` request id; the host half
 * turns that prompt into an in-place rewind, so this half never touches the
 * session log.
 *
 * Replacing an occupied keyed cell is a supported extension point, but it
 * means this package owns the user row's layout. The bubble itself is still
 * the shipped `conversation.chat.user.content` Factory, and the surrounding
 * chrome rebuilds what the shipped row had — clock and copy — so a message
 * loses nothing when this plugin is installed. Retry and edit sit next to the
 * shipped affordances, use their metrics, and disappear into the same
 * hover-reveal behaviour the shipped row uses for older Turns.
 *
 * The log is append-only, so a rewind shadows an interval instead of deleting
 * it. This half therefore keeps a small registry of `[target, replacement)`
 * intervals read from every redo message it renders, dims the messages inside
 * them, and refuses a second rewind there instead of letting the Host throw
 * into the transcript.
 *
 * Images can be removed and added in the editor: a stored image is read back
 * through `readAttachment` (the same RPC image rendering uses), and a newly
 * picked one is encoded in the browser. Files cannot ride this path — a prompt
 * file part is a receipt from a fresh upload and the client has no RPC that
 * reads an existing file attachment back — so a message carrying one keeps its
 * actions disabled instead of silently dropping content.
 *
 * @module dsh-redo/client
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ChatNodeViewProps, UserContentAttachment, UserContentData, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-chat/client'
// Type-only: pulls the client Session service (`ctx.sessions`) and the SlotMap merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls `ctx.uiConversation` and the `chat` target snapshot merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type RedoKey } from './locales.ts'

export const inject = ['slots', 'sessions', 'uiConversation', 'locale']

/** Dictionary namespace owned by this plugin. */
const NS = 'redo'

/** Title/summary shown in the Plugins page for this browser contribution. */
export const description = 'Edit or retry a sent user message and regenerate in place'

/** Outcome of one redo submission, already localized by the caller. */
type RedoResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: 'not-open' | 'rejected' | 'attachment' | 'superseded' | 'running'
    readonly message?: string
  }

/** The failing branch of {@link RedoResult}. */
type RedoFailure = Extract<RedoResult, { readonly ok: false }>

/** Image media types the prompt channel accepts. */
type ImageMediaType = ImageAttachmentRef['mediaType']

/** One image part: a stored image to read back, or bytes already in hand. */
type ImagePart =
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }

/** One part this plugin re-sends: the edited text, or an image. */
type RedoPart = { readonly type: 'text'; readonly text: string } | ImagePart

/** Business face injected into the user-message row. */
export interface RedoInjected {
  /** Session this row belongs to, used to scope the superseded registry. */
  readonly sessionId: SessionId
  /** Active locale id, used for the message clock. */
  readonly localeId: string
  /**
   * Rewind the model context to just before `target` and send `parts` as the
   * next turn.
   * @param target - session seq of the message being replaced.
   * @param parts - text and images to send, in display order.
   * @returns acceptance, or the failure the UI should show.
   */
  resend: (target: number, parts: readonly RedoPart[]) => Promise<RedoResult>
  /**
   * Count the user Turns a rewind of `target` would remove: every later user
   * message still loaded in the Chat target. `undefined` when the count cannot
   * be read, which the UI treats as unknown rather than as zero.
   * @param target - session seq of the message being replaced.
   * @returns later user-message count, or undefined when unknown.
   */
  laterTurns: (target: number) => number | undefined
  /**
   * Observe whether this Session is generating. Redo stays unavailable while
   * it is: a resend must not travel through the Host inbox, and stopping the
   * running answer is the user's own decision.
   */
  subscribeRunning: (listener: () => void) => () => void
  /** @returns whether this Session is generating right now. */
  isRunning: () => boolean
}

/** Full props of the replaced user-message cell. */
type RedoUserMessageProps = Omit<ChatNodeViewProps<'user'>, 't'> & PropsLocale<'redo'> & InjectFace<RedoInjected>

/** Request-id type of the Session prompt call. */
type PromptRequestId = NonNullable<Parameters<SessionFace['prompt']>[3]>

/** Content parts accepted by the Session prompt call. */
type PromptParts = Parameters<SessionFace['prompt']>[0]

/** One shadowed interval: the redo target and the seq of its replacement. */
interface SupersededRange {
  readonly from: number
  readonly to: number
}

/**
 * Interval registry shared by every mounted row. A row that carries a redo
 * request id registers the interval it replaced, so an older row can dim and
 * stop offering an action the Host would reject.
 */
const RANGES = new Map<string, SupersededRange[]>()
const RANGE_LISTENERS = new Set<() => void>()
let rangeRevision = 0

/**
 * Record one replacement interval.
 * @param sessionId - owning Session.
 * @param from - seq of the replaced message.
 * @param to - seq of the replacement message (exclusive upper bound).
 */
function registerReplacement(sessionId: string, from: number, to: number): void {
  const current = RANGES.get(sessionId) ?? []
  if (current.some(range => range.from === from && range.to === to)) return
  RANGES.set(sessionId, [...current, { from, to }])
  rangeRevision += 1
  for (const listener of RANGE_LISTENERS) listener()
}

/**
 * Whether a seq sits inside a shadowed interval.
 * @param sessionId - owning Session.
 * @param seq - message seq to test.
 * @returns true when the message is no longer part of the active context.
 */
function isSupersededSeq(sessionId: string, seq: number): boolean {
  const ranges = RANGES.get(sessionId)
  if (ranges === undefined) return false
  return ranges.some(range => seq >= range.from && seq < range.to)
}

/**
 * Subscribe to interval changes.
 * @param listener - change callback.
 * @returns the unsubscribe function.
 */
function subscribeRanges(listener: () => void): () => void {
  RANGE_LISTENERS.add(listener)
  return () => { RANGE_LISTENERS.delete(listener) }
}

/** @returns the registry revision, a safe `useSyncExternalStore` snapshot. */
function rangesRevision(): number {
  return rangeRevision
}

/** Split durable content blocks into the Factory's prepared shape. */
function contentParts(content: readonly unknown[]): {
  text: string
  attachments: UserContentAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: UserContentAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const candidate = block as { type?: string; text?: string; attachment?: never }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
    else if (candidate.type === 'image' && candidate.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: candidate.attachment } })
    } else if (candidate.type === 'file' && candidate.attachment !== undefined) {
      attachments.push({ type: 'file', file: candidate.attachment })
    } else rest.push(block)
  }
  return { text: texts.join(''), attachments, rest }
}

/** What one durable message offers to the editor. */
interface RedoLayout {
  /** Joined text of every text block, used to prefill the editor. */
  readonly text: string
  /** Stored images in original order, each re-sendable by reading its bytes. */
  readonly images: readonly ImageAttachmentRef[]
  /** A file block is present: its receipt cannot be reused, so refuse instead of dropping it. */
  readonly blockedByFile: boolean
  /** An unknown block is present: refusing beats silently losing content. */
  readonly blockedByOther: boolean
}

/**
 * Split durable content into the parts a redo can carry.
 * @param content - the message's durable content blocks.
 * @returns editor text, stored images, and refusal flags.
 */
function redoLayout(content: readonly unknown[]): RedoLayout {
  const texts: string[] = []
  const images: ImageAttachmentRef[] = []
  let blockedByFile = false
  let blockedByOther = false
  for (const block of content) {
    const candidate = block as { type?: string; text?: string; attachment?: ImageAttachmentRef }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
    else if (candidate.type === 'image' && candidate.attachment !== undefined) images.push(candidate.attachment)
    else if (candidate.type === 'file') blockedByFile = true
    else blockedByOther = true
  }
  return { text: texts.join(''), images, blockedByFile, blockedByOther }
}

/**
 * Build the prompt parts for one send: the text, then the images in display order.
 * @param text - editor text; blank text contributes no part.
 * @param images - stored images, in display order.
 * @returns ordered prompt parts.
 */
function partsFor(text: string, images: readonly ImageAttachmentRef[]): RedoPart[] {
  const parts: RedoPart[] = []
  if (text.trim() !== '') parts.push({ type: 'text', text })
  for (const attachment of images) parts.push({ type: 'image', attachment })
  return parts
}

/** Base64-encode stored bytes without spreading a huge array into one call. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Base64-encode one picked file through the browser's own data-URL encoder. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => { reject(reader.error ?? new Error('redo: image read failed')) }
    reader.readAsDataURL(file)
  })
}

/** Whether a picked file is an image type the prompt channel accepts. */
function isAcceptedImage(file: File): boolean {
  return file.type === 'image/png' || file.type === 'image/jpeg'
    || file.type === 'image/webp' || file.type === 'image/gif'
}

/** Write text the way the shipped message actions do, with a non-secure fallback. */
async function copyText(text: string): Promise<boolean> {
  if (text === '') return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  }
}

/**
 * Format the message clock the way the shipped actions row does: time of day
 * for today, month/day for older messages in this year, full date beyond.
 * @param time - Unix epoch ms.
 * @param localeId - active locale id.
 * @returns the clock label.
 */
function clockLabel(time: number, localeId: string): string {
  const when = new Date(time)
  const now = new Date()
  const sameDay = when.getFullYear() === now.getFullYear()
    && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : when.getFullYear() === now.getFullYear()
      ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  // A bad locale id is a configuration boundary, not a message bug: fall back
  // to the browser's own locale instead of failing the whole row.
  try {
    return new Intl.DateTimeFormat(localeId, options).format(when)
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(when)
  }
}

/** Durable source facts this row reads (producer-owned, so read defensively). */
interface RedoMessageSource {
  readonly rpcId?: unknown
}

/** Whether this durable message was itself produced by a redo. */
function replacedFrom(source: unknown): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const { rpcId } = source as RedoMessageSource
  if (typeof rpcId !== 'string' || !rpcId.startsWith('redo:')) return undefined
  const parsed = Number(rpcId.slice('redo:'.length).split(':')[0])
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

/** Prefer the platform UUID generator; fall back when the page is not a secure context. */
function uuid(): string {
  const generator = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof generator?.randomUUID === 'function') return generator.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** One image in the editor: where it came from decides how it is sent. */
interface EditorImage {
  /** Stable React key. */
  readonly key: string
  /** The part this image becomes on send. */
  readonly part: ImagePart
  /** Preview URL already in hand (picked images only); stored images load in the dialog. */
  readonly previewUrl: string | undefined
  /** True when the preview URL is this editor's own object URL and must be revoked. */
  readonly local: boolean
}

/** Shipped-style icon for the copy action. */
function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5.75" y="5.75" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M10.25 3.5c0-.69-.56-1.25-1.25-1.25H3.75c-.69 0-1.25.56-1.25 1.25V8c0 .69.56 1.25 1.25 1.25"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Shipped-style icon for the copied confirmation. */
function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.2 8.4 6.3 11.5 12.8 4.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * One user bubble with its clock, copy, retry, and edit actions, the editor
 * dialog, and the inline confirmation a rewind needs.
 * @param props - node data, the shipped content Factory, copy, and redo actions.
 * @returns the user row.
 */
function RedoUserMessage({
  node, renderFactorySlot, loadImage, t, resend, laterTurns, subscribeRunning, isRunning,
  sessionId, localeId,
}: RedoUserMessageProps) {
  const data = node.data as UserMessageNode & {
    readonly referenceLabels?: readonly string[]
    readonly skillNames?: readonly string[]
  }
  const parts = useMemo(() => contentParts(data.content), [data.content])
  const content = useMemo<UserContentData>(() => ({
    text: parts.text,
    attachments: parts.attachments,
    extraBlocks: parts.rest,
    ...data.referenceLabels === undefined ? {} : { referenceLabels: data.referenceLabels },
  }), [parts, data.referenceLabels])
  const facts = useMemo(() => ({
    ...data.referenceLabels === undefined ? {} : { sessionLabels: data.referenceLabels },
    ...data.skillNames === undefined ? {} : { skillNames: data.skillNames },
  }), [data.referenceLabels, data.skillNames])

  const scope = String(sessionId)
  const replacementTarget = replacedFrom(data.source)
  // Re-render when any row reports a replacement, so a message that just left
  // the context dims without waiting for its own data to change.
  useSyncExternalStore(subscribeRanges, rangesRevision)
  const superseded = isSupersededSeq(scope, data.seq)

  useEffect(() => {
    if (replacementTarget === undefined) return
    registerReplacement(scope, replacementTarget, data.seq)
  }, [replacementTarget, scope, data.seq])

  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [dropCount, setDropCount] = useState<number | undefined>(undefined)
  const [editorDrops, setEditorDrops] = useState<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const editButton = useRef<HTMLButtonElement | null>(null)

  const layout = useMemo(() => redoLayout(data.content), [data.content])
  // Images are carried over by reading their bytes back; files are not, and an
  // unknown block is content this plugin cannot reproduce.
  const editable = !layout.blockedByFile && !layout.blockedByOther
  const retryable = editable && (layout.text.trim() !== '' || layout.images.length > 0)
  const running = useSyncExternalStore(subscribeRunning, isRunning)
  const canRetry = retryable && !superseded && !running
  const canEdit = editable && !superseded && !running

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
  }, [])

  const fail = useCallback((result: RedoFailure): string => {
    if (result.code === 'not-open') return t('error.notOpen')
    if (result.code === 'attachment') return t('error.attachment')
    if (result.code === 'superseded') return t('error.superseded')
    if (result.code === 'running') return t('error.running')
    return result.message === undefined || result.message === '' ? t('error.rejected') : result.message
  }, [t])

  const runRetry = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    setConfirming(false)
    try {
      const result = await resend(data.seq, partsFor(layout.text, layout.images))
      if (!result.ok) setFailure(fail(result))
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [busy, data.seq, fail, layout, resend])

  const requestRetry = useCallback(() => {
    if (busy || !canRetry) return
    const later = laterTurns(data.seq)
    // Latest message: regenerating only replaces its own answer, so no
    // confirmation. Anything later (or an unreadable count) is destructive
    // enough to ask first.
    if (later === 0) {
      void runRetry()
      return
    }
    setDropCount(later)
    setConfirming(true)
  }, [busy, canRetry, data.seq, laterTurns, runRetry])

  const openEditor = useCallback(() => {
    if (!canEdit) return
    setFailure(undefined)
    setConfirming(false)
    setEditorDrops(laterTurns(data.seq))
    setEditing(true)
  }, [canEdit, data.seq, laterTurns])

  const closeEditor = useCallback(() => {
    setEditing(false)
    requestAnimationFrame(() => { editButton.current?.focus() })
  }, [])

  const copy = useCallback(async () => {
    if (parts.text === '' || copied) return
    const ok = await copyText(parts.text)
    if (!ok) return
    setCopied(true)
    copyTimer.current = window.setTimeout(() => {
      copyTimer.current = null
      setCopied(false)
    }, 1000)
  }, [copied, parts.text])

  const initialImages = useMemo<EditorImage[]>(() => layout.images.map((attachment, index) => ({
    key: `stored:${String(attachment.attachmentId)}:${String(index)}`,
    part: { type: 'image', attachment },
    previewUrl: undefined,
    local: false,
  })), [layout])

  const retryTitle = superseded
    ? t('action.superseded')
    : running
      ? t('action.running')
      : retryable ? t('action.retryHint') : t('action.unsupported')
  const editTitle = superseded
    ? t('action.superseded')
    : running
      ? t('action.running')
      : editable ? t('action.edit') : t('action.unsupported')
  const copyTitle = parts.text === ''
    ? t('action.copyEmpty')
    : copied ? t('action.copied') : t('action.copy')

  return (
    <div className="dsh-redo-row" data-superseded={superseded ? '' : undefined}>
      <div className="dsh-redo-content" data-superseded={superseded ? '' : undefined}>
        {renderFactorySlot('conversation.chat.user.content', { content, loadImage, facts, interactive: true })}
      </div>
      <div className="dsh-redo-meta">
        {superseded
          ? <span className="dsh-redo-flag" title={t('badge.supersededHint')}>{t('badge.superseded')}</span>
          : replacementTarget === undefined
            ? null
            : <span className="dsh-redo-flag" title={t('badge.replacedHint')}>{t('badge.replaced')}</span>}
        {typeof data.time === 'number'
          ? <span className="dsh-redo-time">{clockLabel(data.time, localeId)}</span>
          : null}
        <button
          type="button"
          className="dsh-redo-action"
          aria-label={copyTitle}
          title={copyTitle}
          aria-disabled={parts.text === '' ? true : undefined}
          data-unavailable={parts.text === '' ? true : undefined}
          onClick={(event) => {
            event.stopPropagation()
            void copy()
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          type="button"
          className="dsh-redo-action"
          aria-label={t('action.retry')}
          title={retryTitle}
          aria-disabled={canRetry ? undefined : true}
          data-unavailable={canRetry ? undefined : true}
          data-busy={busy ? true : undefined}
          onClick={(event) => {
            event.stopPropagation()
            requestRetry()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6V6h-3.4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          ref={editButton}
          type="button"
          className="dsh-redo-action"
          aria-label={t('action.edit')}
          title={editTitle}
          aria-disabled={canEdit ? undefined : true}
          data-unavailable={canEdit ? undefined : true}
          data-busy={busy ? true : undefined}
          onClick={(event) => {
            event.stopPropagation()
            openEditor()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M11.1 1.9a1.4 1.4 0 0 1 2 2L5.4 11.6l-2.7.8.8-2.7 7.6-7.8Z"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {confirming
        ? (
          <div className="dsh-redo-confirm" role="group" aria-label={t('confirm.title')}>
            <span className="dsh-redo-confirm-text">
              {dropCount === undefined ? t('confirm.unknown') : t('confirm.text', { count: dropCount })}
            </span>
            <button
              type="button"
              className="dsh-redo-button dsh-redo-small"
              onClick={() => { setConfirming(false) }}
            >
              {t('confirm.cancel')}
            </button>
            <button
              type="button"
              className="dsh-redo-button dsh-redo-small dsh-redo-danger"
              onClick={() => { void runRetry() }}
            >
              {t('confirm.go')}
            </button>
          </div>
        )
        : null}
      {failure === undefined ? null : <div className="dsh-redo-inline-error" role="alert">{failure}</div>}
      {editing
        ? (
          <RedoDialog
            initialText={layout.text}
            initialImages={initialImages}
            loadImage={loadImage}
            droppedTurns={editorDrops}
            t={t}
            onCancel={closeEditor}
            onSubmit={async (editorParts) => {
              const result = await resend(data.seq, editorParts)
              if (!result.ok) return fail(result)
              closeEditor()
              return undefined
            }}
          />
        )
        : null}
    </div>
  )
}

/**
 * The editor: text plus removable/added images. Enter sends from the textarea,
 * Shift+Enter breaks the line, Escape asks before discarding unsent changes.
 * @param props - original text and images, the image loader, the Turns a send
 *   would remove, cancellation, the send round-trip, and copy.
 * @returns the modal overlay.
 */
function RedoDialog({
  initialText, initialImages, loadImage, droppedTurns, onCancel, onSubmit, t,
}: {
  initialText: string
  initialImages: readonly EditorImage[]
  loadImage: RedoUserMessageProps['loadImage']
  droppedTurns: number | undefined
  onCancel: () => void
  onSubmit: (parts: readonly RedoPart[]) => Promise<string | undefined>
  t: RedoUserMessageProps['t']
}) {
  const [text, setText] = useState(initialText)
  const [images, setImages] = useState<EditorImage[]>(() => [...initialImages])
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const input = useRef<HTMLTextAreaElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const overlay = useRef<HTMLDivElement | null>(null)
  const dialog = useRef<HTMLDivElement | null>(null)
  const titleId = useId()
  const hintId = useId()

  // The dialog is portaled to <body>, so the app behind it is inert while it is
  // open: no pointer, focus, or screen-reader access to the transcript, and no
  // wheel chaining into the conversation scroller. Restores whatever was there.
  useEffect(() => {
    const element = overlay.current
    if (element === null) return
    const inerted: HTMLElement[] = []
    for (const child of [...document.body.children]) {
      if (!(child instanceof HTMLElement) || child === element) continue
      // Only rendered app roots matter; inert on script tags is pointless.
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' || child.tagName === 'LINK'
        || child.tagName === 'META' || child.tagName === 'TEMPLATE') continue
      if (child.hasAttribute('inert')) continue
      child.setAttribute('inert', '')
      inerted.push(child)
    }
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      for (const child of inerted) child.removeAttribute('inert')
      document.body.style.overflow = overflow
    }
  }, [])

  // Revoke only this dialog's own object URLs; stored-image addresses are not ours.
  const localUrls = useRef<string[]>([])
  useEffect(() => () => {
    for (const url of localUrls.current) URL.revokeObjectURL(url)
    localUrls.current = []
  }, [])

  useEffect(() => {
    const element = input.current
    if (element === null) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }, [])

  // Stored images need an authorized URL from the session. Load them when the
  // editor opens instead of warming every bubble in the transcript.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const image of initialImages) {
        if (image.local || image.previewUrl !== undefined) continue
        if (!('attachment' in image.part)) continue
        const attachment = image.part.attachment
        const cached = loadImage.peek?.(attachment)
        const url = cached ?? await loadImage(attachment).catch(() => undefined)
        if (url === undefined || cancelled) continue
        setPreviews(current => current[image.key] === undefined ? { ...current, [image.key]: url } : current)
      }
    })()
    return () => { cancelled = true }
  }, [initialImages, loadImage])

  const initialKeys = useMemo(() => imagesFromKeys(initialImages), [initialImages])
  const dirty = text !== initialText || imagesFromKeys(images) !== initialKeys

  const requestClose = useCallback(() => {
    if (busy) return
    if (dirty) {
      setDiscarding(true)
      return
    }
    onCancel()
  }, [busy, dirty, onCancel])

  const remove = useCallback((key: string) => {
    setImages((current) => current.filter((image) => {
      if (image.key !== key) return true
      if (image.local && image.previewUrl !== undefined) URL.revokeObjectURL(image.previewUrl)
      return false
    }))
  }, [])

  const add = useCallback(async (files: FileList | null) => {
    if (files === null || files.length === 0) return
    setPicking(true)
    setError(undefined)
    try {
      const additions: EditorImage[] = []
      for (const file of files) {
        if (!isAcceptedImage(file)) {
          setError(t('error.imageType'))
          continue
        }
        const data = await fileToBase64(file)
        const previewUrl = URL.createObjectURL(file)
        localUrls.current.push(previewUrl)
        additions.push({
          key: `picked:${uuid()}`,
          part: {
            type: 'image',
            mediaType: file.type as ImageMediaType,
            data,
            ...file.name === '' ? {} : { name: file.name },
          },
          previewUrl,
          local: true,
        })
      }
      if (additions.length > 0) setImages(current => [...current, ...additions])
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setPicking(false)
      if (fileInput.current !== null) fileInput.current.value = ''
    }
  }, [t])

  const submit = useCallback(async () => {
    if (busy) return
    const trimmed = text.trim()
    if (trimmed === '' && images.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      const parts: RedoPart[] = []
      if (trimmed !== '') parts.push({ type: 'text', text })
      for (const image of images) parts.push(image.part)
      const failure = await onSubmit(parts)
      if (failure !== undefined) setError(failure)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [busy, images, onSubmit, text])

  const destructive = droppedTurns !== 0
  const sendLabel = droppedTurns !== undefined && droppedTurns > 0
    ? t('dialog.sendDiscard', { count: droppedTurns })
    : t('dialog.send')

  return createPortal(
    <div
      ref={overlay}
      className="dsh-redo-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={dialog}
        className="dsh-redo-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          // IME: the Enter that commits a composition must never send, and
          // Escape during composition must not throw the draft away.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          // Focus stays inside the dialog: the app behind it is inert, and a
          // portaled dialog has no browser-level trap of its own.
          if (event.key === 'Tab') {
            const root = dialog.current
            if (root === null) return
            const focusable = focusableWithin(root)
            const first = focusable[0]
            const last = focusable[focusable.length - 1]
            if (first === undefined || last === undefined) {
              event.preventDefault()
              return
            }
            const active = document.activeElement
            if (active === null || !root.contains(active)) {
              event.preventDefault()
              first.focus()
            } else if (event.shiftKey && active === first) {
              event.preventDefault()
              last.focus()
            } else if (!event.shiftKey && active === last) {
              event.preventDefault()
              first.focus()
            }
            return
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            // Escape dismisses the discard prompt before it asks again.
            if (discarding) {
              setDiscarding(false)
              return
            }
            requestClose()
            return
          }
          if (event.key !== 'Enter' || event.shiftKey) return
          // While the discard prompt is up, Enter must not send behind it.
          if (discarding) return
          // Only the textarea sends; on any other control Enter keeps its own
          // meaning (activate the focused button).
          if (event.target !== input.current) return
          event.preventDefault()
          void submit()
        }}
      >
        <div className="dsh-redo-title" id={titleId}>{t('dialog.title')}</div>
        <textarea
          ref={input}
          className="dsh-redo-input"
          value={text}
          rows={Math.min(12, Math.max(3, text.split('\n').length))}
          spellCheck={false}
          aria-label={t('dialog.textLabel')}
          aria-describedby={hintId}
          placeholder={t('dialog.placeholder')}
          onChange={(event) => { setText(event.target.value) }}
        />
        {images.length === 0 ? null : (
          <div className="dsh-redo-images">
            {images.map(image => {
              const previewUrl = image.previewUrl ?? previews[image.key]
              return (
                <span className="dsh-redo-image" key={image.key}>
                  {previewUrl === undefined
                    ? <span className="dsh-redo-image-placeholder" role="img" aria-label={t('dialog.image')} />
                    : <img src={previewUrl} alt={t('dialog.image')} />}
                  <button
                    type="button"
                    className="dsh-redo-image-remove"
                    aria-label={t('dialog.removeImage')}
                    title={t('dialog.removeImage')}
                    onClick={() => { remove(image.key) }}
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="dsh-redo-row-actions">
          <button
            type="button"
            className="dsh-redo-button dsh-redo-small"
            disabled={busy || picking}
            onClick={() => { fileInput.current?.click() }}
          >
            {t('dialog.addImage')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => { void add(event.target.files) }}
          />
          <span className="dsh-redo-hint" id={hintId}>{t('dialog.hint')}</span>
        </div>
        {destructive
          ? (
            <div className="dsh-redo-warning" role="note">
              {droppedTurns === undefined ? t('dialog.warningUnknown') : t('dialog.warning', { count: droppedTurns })}
            </div>
          )
          : null}
        {discarding
          ? (
            <div className="dsh-redo-discard" role="alert">
              <span className="dsh-redo-confirm-text">{t('dialog.discardText')}</span>
              <button
                type="button"
                className="dsh-redo-button dsh-redo-small"
                onClick={() => { setDiscarding(false) }}
              >
                {t('dialog.discardKeep')}
              </button>
              <button
                type="button"
                className="dsh-redo-button dsh-redo-small dsh-redo-danger"
                onClick={onCancel}
              >
                {t('dialog.discardConfirm')}
              </button>
            </div>
          )
          : null}
        {error === undefined ? null : <div className="dsh-redo-error" role="alert">{error}</div>}
        {discarding
          ? null
          : (
            <div className="dsh-redo-dialog-actions">
              <button type="button" className="dsh-redo-button" onClick={requestClose} disabled={busy}>
                {t('dialog.cancel')}
              </button>
              <button
                type="button"
                className={`dsh-redo-button ${destructive ? 'dsh-redo-danger' : 'dsh-redo-primary'}`}
                onClick={() => { void submit() }}
                disabled={busy || (text.trim() === '' && images.length === 0)}
              >
                {busy ? t('dialog.sending') : sendLabel}
              </button>
            </div>
          )}
      </div>
    </div>,
    document.body,
  )
}

/** Elements the focus trap cycles through, in document order. */
const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'

/**
 * Focusable descendants of one dialog, skipping visually hidden controls.
 * @param root - dialog element.
 * @returns tabbable elements in document order.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null)
}

/**
 * Stable identity for one image list, used to detect removed or added images.
 * @param images - current editor images.
 * @returns a joined key string.
 */
function imagesFromKeys(images: readonly EditorImage[]): string {
  return images.map(image => image.key).join('\u0000')
}

/** Plugin-owned stylesheet: the replaced row owns its own layout. */
const CSS = `
.dsh-redo-row { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; min-width: 0; }
.dsh-redo-content { display: flex; flex-direction: column; align-items: flex-end; width: 100%; min-width: 0; }
.dsh-redo-content[data-superseded] { opacity: .5; transition: opacity .16s ease; }
.dsh-redo-meta {
  display: flex; align-items: center; gap: 8px;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
}
.dsh-redo-flag {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary); white-space: nowrap;
}
.dsh-redo-time {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-tertiary); white-space: nowrap; padding-right: 12px;
}
.dsh-redo-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px; border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer;
  transition: background .1s ease, color .1s ease;
}
.dsh-redo-action svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}
.dsh-redo-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.dsh-redo-action[data-unavailable] { cursor: not-allowed; opacity: .4; }
.dsh-redo-action[data-unavailable]:hover { color: var(--dsw-alias-label-tertiary); background: transparent; }
.dsh-redo-action[data-busy] { opacity: .55; cursor: progress; }
.dsh-redo-inline-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-redo-confirm {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-redo-confirm-text { min-width: 0; }
@media (hover: hover) {
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]) .dsh-redo-row:not([data-superseded]) .dsh-redo-meta {
    opacity: 0; transition: opacity 80ms;
  }
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):hover .dsh-redo-row:not([data-superseded]) .dsh-redo-meta,
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):focus-within .dsh-redo-row:not([data-superseded]) .dsh-redo-meta {
    opacity: 1;
  }
}
.dsh-redo-overlay {
  position: fixed; inset: var(--dsh-frame-chrome-top, 0px) 0 0; z-index: 1200;
  display: flex; align-items: center; justify-content: center;
  background: var(--dsw-alias-bg-mask-1); padding: 24px;
}
.dsh-redo-dialog {
  width: min(680px, 100%); display: flex; flex-direction: column; gap: 10px; padding: 18px;
  border-radius: var(--dsw-radius-panel); border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent); font-family: var(--dsw-font-family);
  animation: dsh-redo-enter var(--ds-transition-duration, .2s) var(--ds-ease-in-out, cubic-bezier(.4, 0, .2, 1));
}
@keyframes dsh-redo-enter {
  from { opacity: 0; transform: translateY(6px) scale(.99); }
  to { opacity: 1; transform: none; }
}
.dsh-redo-title { font-size: 14px; font-weight: 600; }
.dsh-redo-input {
  width: 100%; resize: vertical; min-height: 84px; padding: 10px 12px; box-sizing: border-box;
  border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; outline: none;
}
.dsh-redo-input:focus { border-color: var(--dsw-alias-brand-primary); }
.dsh-redo-images { display: flex; flex-wrap: wrap; gap: 12px; }
.dsh-redo-image { position: relative; display: inline-flex; }
.dsh-redo-image img, .dsh-redo-image-placeholder {
  width: 64px; height: 64px; object-fit: contain; display: block;
  background: var(--dsw-alias-bg-layer-1);
  border-radius: var(--dsw-radius-md); border: 1px solid var(--dsw-alias-border-l2);
}
.dsh-redo-image-placeholder { background: var(--dsw-alias-bg-skeleton); }
.dsh-redo-image-remove {
  position: absolute; top: -8px; right: -8px; width: 24px; height: 24px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); cursor: pointer;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  font-size: 14px; line-height: 1;
}
.dsh-redo-image-remove:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-redo-row-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-redo-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsh-redo-warning { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.dsh-redo-discard {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
}
.dsh-redo-error { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.dsh-redo-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.dsh-redo-button {
  height: 30px; padding: 0 14px; border-radius: var(--dsw-radius-md); cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.dsh-redo-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.dsh-redo-button:disabled { opacity: .5; cursor: not-allowed; }
.dsh-redo-small { height: 26px; padding: 0 10px; font-size: 12px; }
.dsh-redo-primary {
  border-color: transparent; background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted);
}
.dsh-redo-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-redo-danger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
}
.dsh-redo-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 22%, transparent);
}
`

/**
 * The client Session service face this plugin uses.
 *
 * The host `@deepseek-ai/dsh-session` types merge a `sessions` Context key of
 * their own (the host SessionStore), and a browser program that pulls host
 * vocabulary in transitively ends up holding both merges. The runtime object is
 * the Session controller's client service, whose `binding()` this face names.
 */
interface ClientSessionsFace {
  binding(id: SessionId): { readonly session: SessionFace } | undefined
}

/**
 * Read that face off the root context.
 * @param ctx - client root context.
 * @returns the client Session service.
 */
function clientSessions(ctx: Context): ClientSessionsFace {
  return ctx.sessions as unknown as ClientSessionsFace
}

/**
 * Install the user-message redo actions.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-redo: dictionaries')
  ctx.effect(() => {
    const id = 'dsh-redo-style'
    if (document.getElementById(id) !== null) return () => {}
    const style = document.createElement('style')
    style.id = id
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-redo: styles')

  // Identity-stable running source per Session, so every row shares one
  // subscription instead of resubscribing on each render.
  const runningSources = new Map<string, {
    readonly subscribe: (listener: () => void) => () => void
    readonly isRunning: () => boolean
  }>()
  const runningSource = (id: string) => {
    const existing = runningSources.get(id)
    if (existing !== undefined) return existing
    const resolve = () => clientSessions(ctx).binding(id as SessionId)?.session
    const source = {
      subscribe: (listener: () => void) => resolve()?.subscribe(listener) ?? (() => {}),
      isRunning: () => resolve()?.getSnapshot().running ?? false,
    }
    runningSources.set(id, source)
    return source
  }

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    // The shipped cell registers at the default rank 0; a lower rank replaces
    // this one cell without touching any other renderer.
    priority: -10,
    locale: NS,
    inject: (sessionId: string): RedoInjected => ({
      sessionId: sessionId as SessionId,
      // Read per occurrence so a language change updates the clock without a reload.
      localeId: ctx.locale.getLocale().active,
      subscribeRunning: runningSource(sessionId).subscribe,
      isRunning: runningSource(sessionId).isRunning,
      laterTurns: (target) => {
        const binding = clientSessions(ctx).binding(sessionId as SessionId)
        if (binding === undefined) return undefined
        const snapshot = ctx.uiConversation.binding(sessionId as SessionId).target('chat').getSnapshot()
        if (snapshot === undefined) return undefined
        let later = 0
        for (const value of snapshot.nodes.values()) {
          if (value.kind !== 'user') continue
          const data = value.data as { seq?: unknown } | null
          if (typeof data?.seq !== 'number' || data.seq <= target) continue
          // A later message that a previous resend already replaced is not in
          // the context, so a rewind of `target` would not remove it again.
          if (isSupersededSeq(sessionId, data.seq)) continue
          later += 1
        }
        return later
      },
      resend: async (target, parts) => {
        if (isSupersededSeq(sessionId, target)) return { ok: false, code: 'superseded' }
        const binding = clientSessions(ctx).binding(sessionId as SessionId)
        if (binding === undefined) return { ok: false, code: 'not-open' }
        const session = binding.session
        // The row disables redo while generating; this guard covers a race with
        // another client. Stopping the answer is the user's own decision, and a
        // prompt sent mid-turn would surface in the composer queue.
        if (session.getSnapshot().running) return { ok: false, code: 'running' }
        // Stored images travel as bytes; the Host admits them into fresh durable
        // refs. A picked image already carries its bytes. A file part cannot ride
        // this path (it needs a receipt from a new upload).
        const wire = await Promise.all(parts.map(async (part) => {
          if (part.type === 'text') return { type: 'text', text: part.text }
          if ('data' in part) {
            return {
              type: 'image',
              mediaType: part.mediaType,
              data: part.data,
              ...part.name === undefined ? {} : { name: part.name },
            }
          }
          const stored = await session.readAttachment(part.attachment.attachmentId)
          if (!stored.ok) return undefined
          return {
            type: 'image',
            mediaType: part.attachment.mediaType,
            data: toBase64(stored.value.data),
            ...part.attachment.name === undefined ? {} : { name: part.attachment.name },
          }
        }))
        if (wire.some(part => part === undefined)) return { ok: false, code: 'attachment' }
        // A fresh id per attempt: the Host de-duplicates a repeated rpcId, so a
        // second redo of the same message must not reuse the first one's.
        const requestId = `redo:${target}:${uuid()}` as unknown as PromptRequestId
        const result = await session.prompt(wire as unknown as PromptParts, 'queue', undefined, requestId)
        return result.ok ? { ok: true } : { ok: false, code: 'rejected', message: result.error.message }
      },
    }),
  }, RedoUserMessage))
}

export type { RedoKey }
export { RedoUserMessage }
