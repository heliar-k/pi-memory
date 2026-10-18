# Changelog

All notable changes to `@samfp/pi-memory`. Versions follow [semver](https://semver.org/).

## [Unreleased]

Fork-local build (`heliar-k/pi-memory@local/perf`). Not released upstream.

### Changed

- **Consolidation no longer runs while you are waiting.** It used to be awaited
  in `session_before_switch` and `session_shutdown`, which meant a session
  switch or a quit blocked on a spawned `pi` child (1.75 s of boot) plus
  provider latency — measured at 3.9 s end to end. The session tail is now
  queued into a durable outbox (one commit) and drained on `agent_settled`,
  when the session is idle. Quitting during a running drain measured 112 ms
  against a 12 s stand-in child; the interrupted job goes back on the queue and
  the next session retries it.
- Per-turn writes are one transaction per fact at `PRAGMA synchronous=NORMAL`
  instead of the default FULL (85 ms → 13 ms per fact on a slow disk).

### Fixed

- **The FTS indexes are rebuilt only when they are stale.** `migrate()` rebuilt
  both indexes on every open — ~300 ms per `session_start` / `/new` / `/resume`
  on a machine with slow commits — even though the triggers keep them current.
  The guard compares each content table against its `_docsize` shadow table, so
  a pre-FTS database or a dropped trigger still self-heals.
- **A resumed session no longer queues its whole history twice.** Every
  `session_start` re-seeds the tail, so queued jobs are now keyed per session
  and replace the queued tail only when it carries more messages.
- **A quit between "facts written" and "job deleted" no longer leaves a job
  behind.** Both happen in one transaction.
- **`pi -p` runs no longer keep the process alive for ~3 s after the answer.**
  The embedding backfill started at `session_start` held the event loop with an
  in-flight request; it now runs only in `tui`/`rpc` modes.

## [1.6.1] - 2026-10-09

### Fixed

- **A failing `credential_process` is no longer reported as a missing profile.**
  When a Bedrock profile exists but its `credential_process` exits non-zero
  (typically an expired login session behind it), the startup warning now says
  the process failed and quotes its last stderr line, instead of "no AWS
  credentials were found" with an `aws sso login` hint that did not apply.

## [1.6.0] - 2026-09-24

First npm release since 1.5.0. The 1.5.0 tarball on npm was built before the
context-hook work landed, so the injection change below is new to anyone
upgrading from npm.

### Changed

- **Per-turn memory goes through the `context` hook by default**
  (`injectionMode: "context-hook"`). The system prompt is never modified, so
  its prefix cache always holds. On every LLM call in a turn, including
  tool-call continuations, the relevant `<memory>` block is inserted as an
  ephemeral message just before the latest user message. It is never written
  to session history or the consolidation queue. To get the npm 1.5.0
  behaviour back (append to the system prompt each turn), set
  `injectionMode: "system-prompt"`. `perTurnInjection: false` still means a
  single dump at `session_start`.
- The peer dependency is now `typebox` (TypeBox 1.x) rather than
  `@sinclair/typebox`. Pi supplies both.
- `engines.node` is `>=22.19.0`, matching pi.

### Added

- **Hybrid semantic search, opt-in** through `memory.embedding`, with
  providers `bedrock`, `openai`, `mistral`, `ollama` and `openai-compatible`.
  FTS5 keyword hits and cosine-ranked vector hits are merged with Reciprocal
  Rank Fusion (k = 60). Existing entries get embeddings in bounded background
  batches after `session_start`. Leftover 384-dim vectors from the old
  backend are re-embedded automatically. `memory_stats` reports the search
  mode and how much of the store is embedded. The semantic score floor
  (`minScore` 0.15) was calibrated against measured Titan v2 similarities.
  The AWS SDK is an `optionalDependency`, and none of these providers
  needs a native module.
- **Embedding failures now say what is wrong and how to fix it** ([#30]).
  The first failure of each kind in a session shows a warning naming the
  cause and the fix, and `memory_stats` repeats it:
  - optional AWS SDK not installed (the warning includes the install command
    and the package path)
  - AWS credentials missing, expired or denied
  - missing API key
  - HTTP 401, 403, 404 or 429
  - Ollama not running or missing the model

  Keyword search keeps working in every case. The README has a
  troubleshooting table.

### Removed

- The `@xenova/transformers` backend and dependency ([#31]). It pulled in
  vulnerable transitive packages and a native `sharp` binding that needs an
  install script, which was the root cause of [#30]. Its vectors were written
  but never read at query time, so search quality does not change. Nothing
  in the runtime dependency tree needs an install script now, and a test
  enforces that.

### Fixed

- Pi exited with an unhandled promise rejection when the `bedrock` provider
  was configured, the optional AWS SDK was missing, and there was nothing to
  backfill (for example a fresh store). The SDK now loads on first use.
- `openai` and `mistral` with no API key now fail once, at startup, with a
  clear message instead of a 401 on every query. An Ollama batch in which
  every item fails is reported rather than stored as nulls.
- The "🧠 Consolidating memory..." status could stay on the screen after
  `session_shutdown` or `session_before_switch` if consolidation threw.
  It is now always cleared.
- TypeScript errors that failed the release workflow, which is why 1.6.0
  never reached npm.

### Internal

- CI runs on `master`. It used to listen on `main`, so it never ran. The
  release workflow uses npm trusted publishing (no token) and checks that the
  tag matches `package.json`. Both run typecheck, tests, build and a check
  that the committed `dist/` is current.
- `prepare` became `prepack`, so `pi install git:github.com/samfoy/pi-memory`
  (which runs `npm install --omit=dev`) no longer tries to run esbuild, a
  devDependency. `dist/` is committed.
- Dev dependencies moved to pi 0.87. The lockfile was regenerated against
  registry.npmjs.org, and `npm audit --omit=dev` reports 0 vulnerabilities.
- Hook-level tests now cover context-hook injection, system-prompt mode,
  `perTurnInjection: false`, switch-time consolidation and embedding-failure
  reporting.

[#30]: https://github.com/samfoy/pi-memory/issues/30
[#31]: https://github.com/samfoy/pi-memory/pull/31
