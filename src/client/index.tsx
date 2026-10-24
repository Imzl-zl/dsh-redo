/**
 * dsh-redo — browser half.
 *
 * Replaces the keyed `user` Chat node cell so one human message gains two
 * actions: retry it as-is, or move it back into the composer and let the next
 * send rewrite it. Retry sends through the ordinary prompt Remote with a
 * `redo:` request id; edit only *arms* the Host through the `/redo <seq>`
 * command and refills the composer, so the send itself is an ordinary composer
 * submission — the same one the user would type by hand.
 *
 * Replacing an occupied keyed cell is a supported extension point, but it
 * means this package owns the user row's layout. The bubble itself is still
 * the shipped `conversation.chat.user.content` Factory, and the surrounding
 * chrome rebuilds what the shipped row had — clock and copy — so a message
 * loses nothing when this plugin is installed. Both actions sit next to the
 * shipped affordances, use their metrics, and disappear into the same
 * hover-reveal behaviour the shipped row uses for older Turns.
 *
 * The log is append-only, so a rewind shadows an interval instead of deleting
 * it. This half therefore keeps a small registry of `[target, replacement)`
 * intervals, dims the messages inside them, and refuses a second rewind there
 * instead of letting the Host throw into the transcript.
 *
 * A composer rewrite cannot mint its own request id — the composer owns it — so
 * the durable `redo:` marker only exists on the retry path. For the composer
 * path this half registers the interval as soon as the replacement message
 * appears (`ARMED` below): the Host applies the armed rewrite to the very next
 * message, which is exactly the rule used here. The interval registry is memory
 * only, so dimmed history and the 「已重发」 badge survive a reload only for
 * retry-shaped rewinds.
 *
 * Images ride the composer as drafts: stored bytes are read back through
 * `readAttachment`, wrapped as a `File`, and staged with `createDrafts`. Files
 * cannot ride this path — a prompt file part is a receipt from a fresh upload
 * and the client has no RPC that reads an existing file attachment back — so a
 * message carrying one keeps its actions disabled instead of silently dropping
 * content.
 *
 * @module dsh-redo/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
// Type-only: pulls `ctx.conversation`, `ctx.uiConversation`, and the `chat` target merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, zh, type RedoKey } from './locales.ts'

export const inject = ['slots', 'sessions', 'conversation', 'uiConversation', 'locale']

/** Dictionary namespace owned by this plugin. */
const NS = 'redo'

/** Title/summary shown in the Plugins page for this browser contribution. */
export const description = 'Edit or retry a sent user message and regenerate in place'

/** Outcome of one redo action, already localized by the caller. */
type RedoResult =
  | { readonly ok: true }
  | {
    readonly ok: false
    readonly code: 'not-open' | 'rejected' | 'command' | 'attachment' | 'superseded' | 'running'
    readonly message?: string
  }

/** The failing branch of {@link RedoResult}. */
type RedoFailure = Extract<RedoResult, { readonly ok: false }>

/** Image media types the prompt channel accepts. */
type ImageMediaType = ImageAttachmentRef['mediaType']

/** One part a retry re-sends: the message text, or a stored image read back by bytes. */
type RedoPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

/** Full props of the replaced user-message cell. */
type RedoUserMessageProps = Omit<ChatNodeViewProps<'user'>, 't'> & PropsLocale<'redo'> & InjectFace<RedoInjected>

/** Request-id type of the Session prompt call. */
type PromptRequestId = NonNullable<Parameters<SessionFace['prompt']>[3]>

/** Content parts accepted by the Session prompt call. */
type PromptParts = Parameters<SessionFace['prompt']>[0]

/** One composer draft id, derived from the published input actions. */
type DraftId = Parameters<RedoUserMessageProps['inputActions']['addAttachments']>[0][number]

/** What arming one composer rewrite produced. */
type ArmResult =
  | { readonly ok: true; readonly draftIds: readonly DraftId[] }
  | RedoFailure

/** Business face injected into the user-message row. */
export interface RedoInjected {
  /** Session this row belongs to, used to scope the superseded registry. */
  readonly sessionId: SessionId
  /** Active locale id, used for the message clock. */
  readonly localeId: string
  /**
   * Rewind the model context to just before `target` and send `parts` as the
   * next turn, without touching the composer.
   * @param target - session seq of the message being replaced.
   * @param parts - text and images to send, in display order.
   * @returns acceptance, or the failure the UI should show.
   */
  resend: (target: number, parts: readonly RedoPart[]) => Promise<RedoResult>
  /**
   * Arm the Host so the next message sent from this Session's composer rewrites
   * `target`, and stage the message's images as composer drafts.
   * @param target - session seq of the message being replaced.
   * @param images - stored images to stage, in display order.
   * @returns the draft ids the caller adds to the composer, or the failure to show.
   */
  arm: (target: number, images: readonly ImageAttachmentRef[]) => Promise<ArmResult>
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
 * One armed composer rewrite whose replacement seq is not known yet. The Host
 * applies an armed target to the next message the Session sends; this record
 * lets the resulting row register the same interval the retry path learns from
 * its request id.
 */
const ARMED = new Map<string, { readonly target: number; readonly at: number }>()

/** How long an armed record is still assumed to explain the next message. */
const ARM_WINDOW_MS = 10 * 60 * 1000

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
 * The seq one replacement swallowed.
 * @param sessionId - owning Session.
 * @param seq - candidate replacement seq.
 * @returns the replaced seq, or undefined when this message is not a replacement.
 */
function replacedBySeq(sessionId: string, seq: number): number | undefined {
  const ranges = RANGES.get(sessionId)
  if (ranges === undefined) return undefined
  return ranges.find(range => range.to === seq)?.from
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

/** What one durable message offers to the redo actions. */
interface RedoLayout {
  /** Joined text of every text block, used to refill the composer. */
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
 * @returns composer text, stored images, and refusal flags.
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
 * Build the prompt parts for one retry: the text, then the images in display order.
 * @param text - message text; blank text contributes no part.
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

/** File-name extension for one accepted image media type. */
function extensionOf(mediaType: ImageMediaType): string {
  if (mediaType === 'image/jpeg') return 'jpg'
  return mediaType.slice('image/'.length)
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

/** Request-id grammar the Host half mints for a retry: `redo:<seq>:<uuid>`. */
const REDO_RPC_ID = /^redo:(\d+):/u

/** Whether this durable message was itself produced by a retry. */
function replacedFrom(source: unknown): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const { rpcId } = source as RedoMessageSource
  if (typeof rpcId !== 'string') return undefined
  const match = REDO_RPC_ID.exec(rpcId)
  if (match === null) return undefined
  return Number(match[1])
}

/** Prefer the platform UUID generator; fall back when the page is not a secure context. */
function uuid(): string {
  const generator = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof generator?.randomUUID === 'function') return generator.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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
 * One user bubble with its clock, copy, retry, and edit actions, plus the
 * inline confirmation a rewind needs.
 * @param props - node data, the shipped content Factory, copy, the redo
 *   actions, and the Session's published input face.
 * @returns the user row.
 */
function RedoUserMessage({
  node, renderFactorySlot, loadImage, t, resend, arm, laterTurns, subscribeRunning, isRunning,
  sessionId, localeId, inputActions, useInput,
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
  // Only the fields that matter here: the published input state carries much
  // more, and depending on the whole shape would break on an upstream addition.
  const composerOccupied = useInput((state: { readonly draft: string; readonly attachmentIds: readonly unknown[] }) =>
    state.draft.trim() !== '' || state.attachmentIds.length > 0)

  useEffect(() => {
    if (replacementTarget === undefined) return
    registerReplacement(scope, replacementTarget, data.seq)
  }, [replacementTarget, scope, data.seq])

  // A composer rewrite leaves no request id behind: the composer mints its own.
  // The Host applies an armed target to the Session's next message, so the first
  // row newer than the target after arming IS the replacement.
  useEffect(() => {
    const record = ARMED.get(scope)
    if (record === undefined) return
    if (data.seq <= record.target) return
    ARMED.delete(scope)
    if (Date.now() - record.at > ARM_WINDOW_MS) return
    registerReplacement(scope, record.target, data.seq)
  }, [scope, data.seq])

  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<'retry' | 'edit' | undefined>(undefined)
  const [dropCount, setDropCount] = useState<number | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)

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
    if (result.code === 'command') return t('error.command')
    if (result.code === 'attachment') return t('error.attachment')
    if (result.code === 'superseded') return t('error.superseded')
    if (result.code === 'running') return t('error.running')
    return result.message === undefined || result.message === '' ? t('error.rejected') : result.message
  }, [t])

  const runRetry = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    setPending(undefined)
    try {
      const result = await resend(data.seq, partsFor(layout.text, layout.images))
      if (!result.ok) setFailure(fail(result))
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [busy, data.seq, fail, layout, resend])

  const runEdit = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    setPending(undefined)
    try {
      const staged = await arm(data.seq, layout.images)
      if (!staged.ok) {
        setFailure(fail(staged))
        return
      }
      inputActions.setDraft(layout.text)
      if (staged.draftIds.length > 0 && !inputActions.addAttachments(staged.draftIds)) {
        setFailure(t('error.attachment'))
        return
      }
    } catch (thrown) {
      setFailure(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [arm, busy, data.seq, fail, inputActions, layout, t])

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
    setPending('retry')
  }, [busy, canRetry, data.seq, laterTurns, runRetry])

  const requestEdit = useCallback(() => {
    if (busy || !canEdit) return
    const later = laterTurns(data.seq)
    // Arming is the destructive step: the next send rewrites this message. Ask
    // when that send would drop later turns, or would overwrite a live draft.
    if (later === 0 && !composerOccupied) {
      void runEdit()
      return
    }
    setDropCount(later)
    setPending('edit')
  }, [busy, canEdit, composerOccupied, data.seq, laterTurns, runEdit])

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

  const confirmation = pending === 'retry'
    ? dropCount === undefined ? t('confirm.unknown') : t('confirm.text', { count: dropCount })
    : dropCount === undefined
      ? t('confirm.editUnknown')
      : dropCount === 0 ? t('confirm.edit') : t('confirm.editText', { count: dropCount })

  const retryTitle = superseded
    ? t('action.superseded')
    : running
      ? t('action.running')
      : retryable ? t('action.retryHint') : t('action.unsupported')
  const editTitle = superseded
    ? t('action.superseded')
    : running
      ? t('action.running')
      : editable ? t('action.editHint') : t('action.unsupported')
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
          : replacementTarget === undefined && replacedBySeq(scope, data.seq) === undefined
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
          type="button"
          className="dsh-redo-action"
          aria-label={t('action.edit')}
          title={editTitle}
          aria-disabled={canEdit ? undefined : true}
          data-unavailable={canEdit ? undefined : true}
          data-busy={busy ? true : undefined}
          onClick={(event) => {
            event.stopPropagation()
            requestEdit()
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
      {pending === undefined
        ? null
        : (
          <div className="dsh-redo-confirm" role="group" aria-label={t('confirm.title')}>
            <span className="dsh-redo-confirm-text">
              {confirmation}
              {pending === 'edit' && composerOccupied
                ? <span className="dsh-redo-confirm-note">{t('confirm.editReplace')}</span>
                : null}
            </span>
            <button
              type="button"
              className="dsh-redo-button dsh-redo-small"
              onClick={() => { setPending(undefined) }}
            >
              {t('confirm.cancel')}
            </button>
            <button
              type="button"
              className="dsh-redo-button dsh-redo-small dsh-redo-danger"
              onClick={() => { void (pending === 'retry' ? runRetry() : runEdit()) }}
            >
              {pending === 'retry' ? t('confirm.go') : t('confirm.goEdit')}
            </button>
          </div>
        )}
      {failure === undefined ? null : <div className="dsh-redo-inline-error" role="alert">{failure}</div>}
    </div>
  )
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
.dsh-redo-confirm-note { display: block; color: var(--dsw-alias-label-tertiary); }
@media (hover: hover) {
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]) .dsh-redo-row:not([data-superseded]) .dsh-redo-meta {
    opacity: 0; transition: opacity 80ms;
  }
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):hover .dsh-redo-row:not([data-superseded]) .dsh-redo-meta,
  [data-chat-flow-kind=user]:has(~ [data-chat-flow-kind=user]):focus-within .dsh-redo-row:not([data-superseded]) .dsh-redo-meta {
    opacity: 1;
  }
}
.dsh-redo-button {
  height: 30px; padding: 0 14px; border-radius: var(--dsw-radius-md); cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.dsh-redo-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-3); }
.dsh-redo-button:disabled { opacity: .5; cursor: not-allowed; }
.dsh-redo-small { height: 26px; padding: 0 10px; font-size: 12px; }
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
 * The draft-staging half of the Conversation service.
 *
 * `createDrafts` lives on the exported `ConversationController`, not on the
 * `IConversation` face `ctx.conversation` publishes, so the narrow shape this
 * plugin needs is named here instead of widening an upstream type.
 */
interface ConversationDraftsFace {
  createDrafts(
    sessionId: SessionId,
    files: readonly File[],
    uploadImages: boolean,
  ): readonly { readonly id: DraftId }[]
}

/**
 * Read that face off the root context.
 * @param ctx - client root context.
 * @returns the draft staging service.
 */
function conversationDrafts(ctx: Context): ConversationDraftsFace {
  return ctx.conversation as unknown as ConversationDraftsFace
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
      arm: async (target, images) => {
        if (isSupersededSeq(sessionId, target)) return { ok: false, code: 'superseded' }
        const binding = clientSessions(ctx).binding(sessionId as SessionId)
        if (binding === undefined) return { ok: false, code: 'not-open' }
        const session = binding.session
        // The row disables redo while generating; this guard covers a race with
        // another client. An armed rewrite would land in the composer queue.
        if (session.getSnapshot().running) return { ok: false, code: 'running' }
        const armed = await session.command(`/redo ${String(target)}`)
        if (!armed.ok) return { ok: false, code: 'rejected', message: armed.error.message }
        if (!armed.value.matched) return { ok: false, code: 'command' }
        // Stored images are read back as bytes and staged as ordinary composer
        // drafts, so the send path stays the one the user knows. A failed read
        // disarms again instead of leaving a rewrite that would drop images.
        const files: File[] = []
        for (const [index, image] of images.entries()) {
          const stored = await session.readAttachment(image.attachmentId)
          if (!stored.ok) {
            await session.command('/redo off')
            return { ok: false, code: 'attachment' }
          }
          files.push(new File(
            [stored.value.data],
            image.name ?? `redo-${String(target)}-${String(index)}.${extensionOf(image.mediaType)}`,
            { type: image.mediaType },
          ))
        }
        const drafts = files.length === 0
          ? []
          : conversationDrafts(ctx).createDrafts(sessionId as SessionId, files, true)
        ARMED.set(sessionId, { target, at: Date.now() })
        return { ok: true, draftIds: drafts.map(draft => draft.id) }
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
        // refs. A file part cannot ride this path (it needs a receipt from a new
        // upload).
        const wire = await Promise.all(parts.map(async (part) => {
          if (part.type === 'text') return { type: 'text', text: part.text }
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
        const requestId = `redo:${String(target)}:${uuid()}` as unknown as PromptRequestId
        const result = await session.prompt(wire as unknown as PromptParts, 'queue', undefined, requestId)
        return result.ok ? { ok: true } : { ok: false, code: 'rejected', message: result.error.message }
      },
    }),
  }, RedoUserMessage))
}

export type { RedoKey }
export { RedoUserMessage }
