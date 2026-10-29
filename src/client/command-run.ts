/**
 * What one `/redo` command run means for the composer.
 *
 * The Host answers a resolved command with the handler's own outcome, and that
 * outcome is the whole point: `/redo` refuses a click **before** it writes
 * anything (`busy` while a Turn is still open, `missing` once the target left
 * the context, `head`, `not-user`), and a refusal has to reach the composer as
 * a refusal. Reading "the command matched" as "the retraction happened" refills
 * the composer while the message stays in the conversation — the one visible
 * failure this plugin must never produce.
 *
 * `Session.command()` cannot answer this: it projects the execution to
 * `{ matched }` and drops the handler result (upstream
 * `client/sessions/session.ts`), which is why the caller asks
 * `commands.execute` for the full acknowledgment and classifies it here.
 *
 * Kept free of React and of the client Context so the mapping is unit-testable
 * on its own, and so the bridge test can feed it a real Host refusal.
 *
 * @module dsh-redo/client/command-run
 */

/** One command handler outcome, as the Host normalizes it. */
export interface CommandResultLike {
  /** `'error'` means the handler refused or threw; nothing was rewritten. */
  readonly kind: 'success' | 'error'
  /** The handler's own text for a refusal. */
  readonly text?: string
}

/** The Remote acknowledgment a resolved command settles to. */
export interface CommandExecutionLike {
  /** The handler's normalized outcome. */
  readonly result: CommandResultLike
}

/** One `commands.execute` outcome: an acknowledgment, a miss, or a transport failure. */
export type CommandRun =
  | { readonly ok: true; readonly value: CommandExecutionLike | undefined }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** The composer-facing verdict: retraction happened, or why it did not. */
export type CommandVerdict =
  | { readonly ok: true }
  | {
    readonly ok: false
    /** `'command'`: no such command. `'rejected'`: the Host refused, or the call failed. */
    readonly code: 'command' | 'rejected'
    /** The Host's own refusal text, when it gave one. */
    readonly message?: string
  }

/**
 * Decide whether a command run actually retracted the message.
 * @param run - the acknowledgment `commands.execute` returned.
 * @returns success only for a matched command whose handler succeeded.
 */
export function classifyCommandRun(run: CommandRun): CommandVerdict {
  if (!run.ok) return { ok: false, code: 'rejected', message: run.error.message }
  if (run.value === undefined) return { ok: false, code: 'command' }
  // A handler error is a refusal that already left the log untouched: the
  // replacement was never written, so the composer must not be refilled.
  if (run.value.result.kind === 'error') return { ok: false, code: 'rejected', message: run.value.result.text }
  return { ok: true }
}
