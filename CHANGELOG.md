# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This plugin talks to a host that has no compatibility shims, so the DSH version each release was
built against is recorded alongside it.

## [0.3.1] - 2026-10-26

Built against DSH `0.2.1-rc.3`.

### Fixed

- **A retraction clicked while a Turn was still open no longer writes an unreadable log.** `/redo`
  used to open its Turn with `max(turn) + 1` and never asked whether a Turn was already open, so a
  click that raced generation (a second window on the same Session, a lagging `running` flag in the
  client) appended a second `turn/start` inside the open Turn. The host writes that blindly, and the
  next history load then refused the whole Session with
  `SessionFormatError: turn/start does not open the expected turn` — permanently, because the log is
  append-only. The command now reads the host's own `turnBoundary` projection: no open Turn and the
  number after the last one, or a refusal that writes nothing.
- Turn numbers are no longer derived by scanning the log for the highest one. The `turnBoundary` fold
  is the same source the loop and the log reader use, so the Turn this plugin opens can no longer
  disagree with the one the loop opens next. A host that does not expose that projection is an error,
  not a guess.

### Added

- `scripts/check-sessions.mjs` reads stored sessions with the release V4 validator and names the first
  event a history load would refuse; `scripts/verify-retract-safe.ts` runs one real `/redo` click
  against a real stored log — between Turns it must write a readable log, inside an open Turn it must
  write nothing.

## [0.3.0] - 2026-10-24

Built against DSH `0.2.1-rc.2`.

### Changed

- **编辑重发当场撤回。** Clicking 编辑重发 rewrites the model context right there: `/redo <seq>` opens a Turn,
  writes the replacement inside its only Step, and closes both. The message leaves the context at the click —
  not at the next send — and its text and images land in the composer. There is no latch and no expiry any more,
  so a retracted message cannot come back.
- **A rewound Turn now leaves the transcript instead of dimming.** The message, its answer, the tool cards,
  the process row and the usage tail all go away, and the replacement Turn lands in the same place — a retry
  reads as "this message generated again", which is what kept it distinct from sending the same text by hand.
- The shadowed intervals **and the retraction Turn itself** are derived from the Session's own event window
  (`surfaceOp: replace` plus turn boundaries) by the new `src/client/intervals.ts`, so the hide survives a
  reload and both entry points behave the same. The previous in-memory registry kept only `redo:`-shaped
  rewinds after a refresh.
- The `redo` command card that caused a retraction is hidden once its target is shadowed (a command is a
  log-only event, so its seq sits outside the replaced surface interval).
- The empty Turn that carries a retraction has no message of its own, but the Chat flow still renders its
  process and usage rows; a `MutationObserver` and the retraction-turn derivation keep those off the screen.
- Action hints and the confirmation row now say "withdraw" rather than "leave the context".

### Removed

- The dimmed rendering of replaced messages, the `已被替换` / `已重发` badges, and the in-memory interval
  registry behind them, along with the five locale keys only they used.
- The armed latch in the Host (`ARM_TTL_MS`, `/redo off`) and the client-side retraction record: the replacement
  is written at the click, so neither is needed.

### Added

- `test/intervals.test.ts` (6 cases): which surface markers count, the closed range, malformed markers, that a
  reload rebuilds the same answer from the log alone, and which Turns exist only to carry a retraction.

## [0.2.1] - 2026-10-24

Documentation-only release: the files in this tarball now match the repository.

- Built against DSH `0.2.1-rc.2`.

### Added

- `CHANGELOG.md`, so a release never has to be reconstructed from `git log`.
- A tag-driven release workflow that publishes with npm trusted publishing (OIDC) and
  provenance, replacing the manual token path.

### Changed

- Install instructions lead with the npm package (`dsh plugin --profile <name> add dsh-redo`);
  the source build stays documented for tracking unreleased work.
- `AGENTS.md` records the release checklist instead of the one-off incident notes.

## [0.2.0] - 2026-10-24

- Built against DSH `0.2.1-rc.2`.

### Changed

- **Editing now happens in the composer.** Clicking 编辑重发 arms the host through the
  `/redo <seq>` command and refills the native composer (text plus images) instead of opening a
  plugin-owned dialog. The send that follows is an ordinary composer submission.
- The armed target is bound to one agent, consumed by the next human prompt, and expires after
  five minutes; `/redo off` disarms it, and an explicit `redo:` request id always outranks it.

### Removed

- The portal dialog, its focus trap, its file picker, and the client-side image encoding path —
  about 600 lines, and the `react-dom` runtime dependency.

### Fixed

- A malformed request id such as `redo::uuid` parsed as target `0` (the protected session head)
  and turned a no-op into a host error. Targets are now parsed as digits only.

### Added

- A host test suite (18 cases) covering the rewind invariants and the armed path.
- Continuous integration runs the suite on Node 24, matching the TypeScript-stripping toolchain.

## [0.1.0] - 2026-10-24

Initial release.

- Built against DSH `0.2.1-rc.2`.

### Added

- Retry any already-sent user message in place: the model context is rewound to just before it
  and the prompt is replayed as-is.
- Edit a sent message (text and images) and resend it, dimming the replaced messages and the
  turns after them.
- Append-only rewriting through a single `surface replace` of `target .. surface tail`, with an
  empty `system/message` as the replacement so it never projects to a model message.
- Inline confirmation before a mid-conversation rewrite, with the number of turns it drops.

[Unreleased]: https://github.com/Imzl-zl/dsh-redo/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Imzl-zl/dsh-redo/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Imzl-zl/dsh-redo/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Imzl-zl/dsh-redo/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Imzl-zl/dsh-redo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Imzl-zl/dsh-redo/releases/tag/v0.1.0
