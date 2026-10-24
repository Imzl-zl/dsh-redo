# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This plugin talks to a host that has no compatibility shims, so the DSH version each release was
built against is recorded alongside it.

## [Unreleased]

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

[Unreleased]: https://github.com/Imzl-zl/dsh-redo/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Imzl-zl/dsh-redo/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Imzl-zl/dsh-redo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Imzl-zl/dsh-redo/releases/tag/v0.1.0
