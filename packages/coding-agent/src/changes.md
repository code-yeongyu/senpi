# changes

## 2026-08-30 - Dispatch the internal RPC host route through wrapper-injected argv

### What changed

- `packages/coding-agent/src/main.ts` matches the hidden `--internal-rpc-host-supervisor` route through `findInternalSupervisorArgs()` instead of a strict `args[0]` comparison, and still fails closed with `exit(2)` when the payload does not parse.

### Why

- A rebranded wrapper re-dispatches this binary through its own entry and prepends `--extension <dir>` for every non-early command, which pushed the sentinel off `args[0]`. The internal route then never fired and the spawned helper died on `--socket`, so compiled wrapper builds could never start the shared host.

### Why an extension could not handle it

- The dispatch happens in the CLI entry before argument parsing and before any extension host exists, so no extension hook can observe or rewrite it.

### Expected merge conflict zones

- LOW: the internal-route dispatch block near the top of `main()`.


## Measure Cursor tool-result history at the wire representation (2026-08-29)

### What changed

- `packages/coding-agent/src/core/agent-session.ts` admits Cursor context using the actual serialized history bytes, accounting for tool names, call IDs, MIME types, arguments, and framing instead of a fixed envelope estimate. Oldest result bodies are emptied first, with complete oldest turns removed only when metadata alone exceeds the bound.
- `packages/ai/src/api/cursor-agent.ts` exposes the shared serialized-history measurement used by the admission transform.

### Why

- Cursor history must stay at or below 50,000 serialized bytes without evicting results from histories that genuinely fit.

### Why an extension could not handle it

- Admission occurs in the core Cursor context transform before provider execution.

### Expected merge conflict zones

- LOW: Cursor admission constants and `truncateToolResultBodies()` in `agent-session.ts`.

## 2026-08-29 - Propagate shared-host bash callback failures

### What changed

- `packages/coding-agent/src/core/agent-session.ts` observes asynchronous bash output callbacks and preserves callback failures through cleanup.
- `packages/coding-agent/src/modes/interactive/interactive-host-runtime.ts` aborts shared-host commands when callbacks reject and rethrows the original value.

### Why

- Public shared-host bash execution could resolve successfully after an asynchronous callback rejection and leave large-output spill files behind.

### Why an extension could not handle it

- Core session and RPC proxy callback dispatch occurs before extension code can finalize execution cleanup.

### Expected merge conflict zones

- LOW: bash callback dispatch in the core session and interactive host runtime.

## Honor --auto-title-sessions outside interactive mode (2026-08-28)

### What changed

- `packages/coding-agent/src/main.ts` resolves session auto-titling through the exported `resolveAutoTitleSessions(appMode, parsed, hasContextMessages)` helper: interactive launches keep titling by default, any app mode opts in with `--auto-title-sessions`, and sessions resumed with context messages are still never retitled. Because the shared `createRuntime` closure is also what the multi-session RPC host calls through `RpcSessionRegistry.openSession`, both the classic and multi-session RPC paths honor the flag without extra plumbing.

### Why

- RPC clients (the desktop app spawns `--mode rpc --multi-session`) never received generated session titles even though `setSessionName()` already emits `session_info_changed` and the RPC connection handler already forwards it.

### Why an extension could not handle it

- The auto-title decision is made while the entrypoint constructs the first `AgentSession`, before extensions load.

### Expected merge conflict zones

- LOW: the `autoTitleSessions` argument in the `createAgentSessionFromServices` call and the helper beside `toProjectTrustMode`.

## Credential accounts in auth check --json (2026-08-27)

### What changed

- `packages/coding-agent/src/main.ts`: `auth check --json` output gains a non-secret `accounts` array (name/source/blocked/pinned) for the checked provider, sourced from `core/credential-accounts.ts`; enrichment failures never turn a readable auth state into an error, and non-JSON output is unchanged.

### Why

- Scripts consuming `auth check --json` need visibility into a provider's credential pool without parsing auth.json themselves.

### Why an extension could not handle it

- The auth-check CLI output is composed in the entrypoint's command handling, which extensions cannot alter.

### Expected merge conflict zones

- LOW: one enrichment block in the auth-check branch.

## 2026-08-25 - Keep JSON startup logging off stdout

### What changed

- `packages/coding-agent/src/main.ts` takes over stdout for JSON `--help` and redirects `console.log` to stderr for the lifetime of JSON-mode execution, restoring the original logger on process exit.

### Why

- Machine-readable JSON output must remain clean while startup diagnostics and trusted chatter continue to be visible on stderr.

### Why an extension could not handle it

- CLI mode selection and stdout ownership happen before extensions load and are process-wide runtime behavior.

### Expected merge conflict zones

- LOW: JSON-mode startup setup around `resolveAppMode()` and stdout takeover.

## Coding-agent entry surfaces re-diverge from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/config.ts` keeps the bun global-launcher repair command, brand-profile
  and `envValue` plumbing, nearest-parent config discovery, and multi-step self-update commands.
- `packages/coding-agent/src/index.ts` keeps the fork public surface: `sanitizeTerminalLabel`,
  `OAuthCredential`, `CacheFriendlySummaryOptions`, the filesystem-policy and extension-RPC contract types, and notice primitives.
- `packages/coding-agent/src/migrations.ts` keeps the fork migration chain (brand-dir,
  extension-system, legacy-senpi dirs) in place of upstream's commands-to-prompts migration.
- `packages/coding-agent/src/package-manager-cli.ts` keeps senpi-branded update help text and the
  removable `omo-local-update` beta hook.
- `packages/coding-agent/src/main.ts` keeps the fork stdout contract for JSON mode: stdout takeover
  also applies to `--help` in JSON mode, and `console.log` is redirected to stderr for the process
  lifetime so machine-readable stdout stays clean of stray logging.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that the new upstream tree does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Export lists in `packages/coding-agent/src/index.ts`, the migration registry in
  `packages/coding-agent/src/migrations.ts`, and update-help templates in
  `packages/coding-agent/src/package-manager-cli.ts`.

## Preserve zero-usage context estimation for auto-compaction (2026-08-25)

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: allow the fork-owned estimated context size to drive threshold compaction even when no prior assistant usage index exists.

### Why

- The fork's zero-usage regression guard depends on message estimation; upstream's no-usage early return silently disables compaction for malformed or provider-zero usage responses.

### Why an extension could not handle it

- Automatic compaction admission is internal session state evaluated before extension compaction hooks run.

### Expected merge conflict zones

- HIGH: `_checkCompaction` threshold accounting and fork compaction safeguards.

## Restore fork settings paths and interactive startup seams after upstream merge (2026-08-25)

### What changed

- `packages/coding-agent/src/core/settings-manager.ts`: preserve fork `.senpi` settings discovery while adopting upstream BOM-tolerant parsing and path-bearing diagnostics.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: retain the fork's testable tmux-keyboard startup seam while adopting the upstream startup warning flow.

### Why

- The fork's branded config directory and interactive startup contracts are production behavior; allowing upstream `.pi` assumptions or an unmocked method call breaks settings persistence and startup diagnostics.

### Why an extension could not handle it

- Settings source selection and interactive startup dispatch run before extensions are loaded.

### Expected merge conflict zones

- HIGH: settings source resolution, error reporting, and interactive startup checks.

## Preserve highlight.js package export compatibility after upstream merge (2026-08-25)

### What changed

- `packages/coding-agent/src/utils/syntax-highlight.ts`: use highlight.js package-export subpaths compatible with the fork's pinned 11.12.0 release, including the root package for lazy grammar loading.

### Why

- Upstream's source import suffixes are not exported by highlight.js 11.12.0 under Node and Vite, preventing child-process startup and causing the test prerequisite to fail.

### Why an extension could not handle it

- Syntax-highlighter module resolution happens during CLI and TUI module loading, before extensions are initialized.

### Expected merge conflict zones

- MEDIUM: highlight.js imports and deferred grammar loading in the syntax-highlighting utility.

## 2026-08-25 - brand executable name for shell-command contexts

### What changed

- `packages/coding-agent/src/config.ts`: exports `APP_COMMAND` from `BRAND?.command`, falling back to `APP_NAME`, so shell-command strings can use the real binary when it differs from the display name.

### Why

- A brand can present as `OmO` while the installed executable is `omo`. Resume hints and other copy-paste commands must name the binary the shell can run.

### Why an extension could not handle it

- Brand identity constants are resolved at module load, before the extension loader exists; every later command-line interpolation reads these exports.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/config.ts` identity constants next to `APP_NAME`.

## 2026-08-25 - Lazy-load the interactive mode at the CLI mode seam

### What changed

- `packages/coding-agent/src/main.ts`: RPC and print mode imports remain eager, while `InteractiveMode` is loaded dynamically only after the final mode is known to be interactive.

### Why

- RPC children are headless and never construct the interactive TUI. Keeping the interactive mode import in the shared static mode barrel made the full component tree parse during RPC startup. The dynamic boundary removes that interactive-only work from the RPC boot path while preserving the same interactive import immediately before its first use.

### Why an extension could not handle it

- Mode selection and entry-module loading happen before extensions are loaded; only the CLI coordinator can keep an unused mode graph out of the RPC child entry.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/main.ts` mode imports and the final interactive dispatch branch.
## Export client-side RPC socket host ensuring (2026-08-24)

### What changed

- `packages/coding-agent/src/index.ts` and `packages/coding-agent/src/modes/index.ts` export `ensureHost`, its state-path helper, result/options types, and the pinned shared-host capability profile.

### Why

- Desktop and other package consumers need to auto-start or reuse the compatible shared RPC socket host through a supported library API.

### Why an extension could not handle it

- The package entry point owns the supported programmatic API before any session or extension runtime exists.

### Expected merge conflict zones

- LOW: additive RPC exports in the two index modules.

## Route RPC listen addresses into the shared multi-session host (2026-08-23)

### What changed

- `packages/coding-agent/src/main.ts` forwards the parsed RPC `--listen` address to `runMultiSessionHost` while preserving the existing no-default-runtime startup branch.

### Why

- The Unix-socket transport must own one process-global multi-session host rather than constructing the classic single-session runtime before binding.

### Why an extension could not handle it

- Main-mode dispatch and pre-runtime host selection happen before session extensions exist.

### Expected merge conflict zones

- LOW: the existing multi-session dispatch object in `main.ts`.


## 2026-08-22 - emit agent_idle after settlement-deferred turns resolve

### What changed

- `packages/coding-agent/src/core/agent-settled-delivery.ts`: added `DeferredTurnClaim` / `DeferredTurnDisposition` (`started` / `delegated` / `finished-without-start`) and `deferTriggerTurn`, so a settlement-deferred `sendMessage(..., { triggerTurn: true })` declares whether it actually started a run. Claims resolve at the `_promptAgent` admission boundary.
- `packages/coding-agent/src/core/agent-session.ts`: after the deferred-action loop in `_emitAgentSettled`, an out-of-band check waits for all deferred turn dispositions, skips emission when any turn `started`, waits for delegated session work to drain, verifies the settlement epoch is still current, and emits `{ type: "agent_idle" }` only when no agent run or session work is active. Both settlement-deferred turn APIs register a claim: `sendMessage(..., { triggerTurn: true })` via `deferTriggerTurn`, and `sendUserMessage` (which always triggers a turn) via a claim resolved from its prompt disposition. `agent_settled` ordering is unchanged for existing subscribers.

### Why

- The TUI cleared its working-status dock on the public `agent_settled`, but settlement-deferred continuations (TTSR, loop-guard, goal recovery) start a turn *after* that event, so the dock was removed and immediately remounted - the same vertical bounce the jitter fix exists to eliminate. `_isAgentRunActive` alone cannot decide this at the deferred-action loop because a deferred `sendCustomMessage` can be suspended at compaction/provider admission before reaching `_promptAgent`. `agent_idle` is the single race-free boundary for final cleanup.

### Why an extension could not handle it

- Settlement-deferred turn admission and the settlement epoch are private `AgentSession` / `AgentSettledDelivery` state.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_emitAgentSettled`, `_promptAgent`, and the `AgentEvent` union.
- `packages/coding-agent/src/core/agent-settled-delivery.ts`.

## 2026-08-22 - Bun-installed CLIs re-exec onto the Bun runtime

### What changed

- `packages/coding-agent/src/cli.ts` now runs a runtime check as its first statement, before `enableStartupCompileCache()`: it realpaths `process.argv[1]`, asks the fork-only `packages/coding-agent/src/bun-runtime.ts` decision function whether this process should run under Bun, and on a positive decision `spawnSync`s the installed `bun` binary with the same script and arguments, propagates the child's signal or exit status, and exits without loading the rest of the entry flow.

### Why

- `bun install -g` links the CLI into `~/.bun/bin`, but the shebang still selects Node, so users who installed with Bun silently ran on the Node runtime. The check has to precede compile-cache setup so a re-exec never pays for Node-only startup work, and it honors `SENPI_RUNTIME=node`/`bun`, keeps debugger runs on Node, and never re-execs when `process.versions.bun` is already set.

### Why an extension could not handle it

- Runtime selection happens before any extension, session, or engine module is loaded; by the time an extension could run, the process is already committed to its interpreter.

### Expected merge conflict zones

- LOW: the import block and the first statements of `packages/coding-agent/src/cli.ts`, immediately above the existing `enableStartupCompileCache()` call.

## 2026-08-20 - Cursor 0-token RE stays on the same model and shrinks

### What changed

- `packages/coding-agent/src/core/agent-session.ts`: 0-token Cursor `resource_exhausted` retries with `sameModelRemint` instead of 429/k3 fallback; overflow compact uses Cursor keep-recent-0 settings; too-small compact truncates to the last user turn.

### Why

- `resource.?exhausted` was classified as a 429 transient fallback, and overflow compact that saved <1% still retried the same Cursor payload.

### Why an extension could not handle it

- Retry fallback and pre-prompt compaction are core AgentSession admission paths.

### Expected merge conflict zones

- `packages/coding-agent/src/core/agent-session.ts` `_handleRetryableError`, `_executeCompaction`, `_isHardErrorFallbackEligible`.

## Public notice renderer primitives (2026-08-20)

### What changed

- `packages/coding-agent/src/index.ts` now exports `buildNoticeBox`, `noticeMessageRenderer`, `noticeEntryRenderer`, and the `NoticeSpec`, `NoticeLine`, and `NoticeTone` types.

### Why

- Extensions and package consumers need the same notice-card contract as built-in transcript surfaces instead of recreating its background, title, and detail styling.

### Why an extension could not handle it

- The package entry point owns the supported public API; an extension cannot export additional symbols from it.

### Expected merge conflict zones

- LOW: the notice export block in `packages/coding-agent/src/index.ts`.

## 2026-08-19 - Session title uses session-model auth

### What changed

- `_generateSessionTitle` now calls `_getSummarizationRequestAuth(model)` instead of `_getCompactionRequestAuth(model)`.

### Why

- Compaction auth can be remapped to another provider (see #974). Title generation still streams with the **session** model, so a remapped key produces `session_title_generation` `unauthenticated` on Cursor while the main turn works.

### Why an extension could not handle it

- Title generation is private session lifecycle. There is no extension hook for the title complete auth.

### Conflict zone

- `packages/coding-agent/src/core/agent-session.ts` `_generateSessionTitle`.

## 2026-08-19 - Skip Cursor compaction while a Run is live

### What changed

- `compactBeforeNextAdmission` no-ops for `cursor` / `cursor-cli-oauth`.
- Blocking and generated compaction refuse those providers while `!ctx.isIdle()`.

### Why

- Cursor rebuilds full conversation state each hop. Mid-turn compact desyncs `conversationId` and the next hop returns 0-token `resource_exhausted` (session 01a01879).

### Conflict zone

- `packages/coding-agent/src/core/agent-session.ts` `compactBeforeNextAdmission`
- `packages/coding-agent/src/core/extensions/builtin/compaction/index.ts` `applyBlockingCompaction`
- `packages/coding-agent/src/core/extensions/builtin/compaction/speculative.ts` `applyGeneratedCompaction`

## 2026-08-19 - Ignore implausible Cursor usage for compaction threshold

### What changed

- `_resolveThresholdContextTokens` uses `resolveThresholdContextTokens`: if the local estimate is at least 50k and billed usage is more than 8× that estimate, compact against the estimate.

### Why

- Complements the billed-cacheRead guard. When no checkpoint arrived, a 4M `cacheRead` still must not beat a 149k transcript estimate.

### Conflict zone

- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/src/core/agent-session.ts` `_resolveThresholdContextTokens`

## In-process CLI fast path when no isolation is required (2026-08-20)

### What changed

- `packages/coding-agent/src/cli.ts` no longer always re-spawns Node to run the agent. It now decides
  with `requiresIsolatedProcess()` — `process.execArgv.length > 0 || hasInheritedInspectorOption()`.
  When false (the overwhelmingly common launch), it loads the agent with a dynamic
  `await import("./cli-main.ts")` in the launcher process itself. When true, the previous child spawn
  is kept byte-for-byte, including `releaseInheritedInspectorForChild()`, `process.execArgv`
  forwarding, `stdio: "inherit"`, exit-code forwarding, and signal re-raise via
  `process.kill(process.pid, signal)`.
- The former `runFullCli()` is renamed `spawnFullCli()` and is now reached only on the isolation path;
  the fast path has no result to forward, because `cli-main` runs `main()` at module scope and already
  owns `process.exitCode` and any `process.exit()` of its own.
- `packages/coding-agent/src/inspector-policy.ts` exports the previously private
  `hasInheritedInspectorOption()` (unchanged logic: `--inspect*` in `process.execArgv`, or `--inspect`
  inside `NODE_OPTIONS`) so `cli.ts` decides with exactly the predicate that governs the existing
  Inspector handoff, rather than a second, drifting copy of it.
- Ordering with the compile cache (merged separately, same day) is preserved and is load-bearing:
  `enableStartupCompileCache()` still runs as the first statement, BEFORE the dynamic import, so on the
  fast path the dynamically imported engine graph is itself compile-cached in-process, and on the
  isolation path `NODE_COMPILE_CACHE` is still published for the child to inherit. The comment on that
  call now states both roles.
- The two documented reasons for the respawn were re-verified. Inspector socket handoff still requires
  a separate process and is preserved. Brand env isolation does NOT: `cli-main.ts` calls
  `scrubBrandFromEnvironment()` itself (`src/core/brand.ts`), so an in-process load scrubs this
  process's environment before anything the agent later spawns can inherit it.

### Why

- The respawn cost a full Node process launch plus a duplicated entry-module graph on every single
  launch, for isolation that almost no launch needs. Measured on this fork's built dist (Apple M4 Pro,
  node v26.7.0, hyperfine 15 runs, 3 warmup): `node dist/cli.js --help` 1.206 s ± 0.049 -> 1.131 s ±
  0.036 (-75 ms, -6.2%). The untouched control `dist/cli-main.js --help` is unchanged across the same
  pair of builds, and after the change `cli.js` is faster than `cli-main.js` itself — the launcher no
  longer pays for a second process. System CPU per launch drops 0.513 s -> 0.397 s (12-run
  `/usr/bin/time` means), which is where an eliminated spawn is expected to show up.

### Why an extension could not handle it

- This is the process structure of the entrypoint itself: the decision happens in `cli.ts` before any
  session, extension loader, or extension API exists, and it determines which process the extension
  loader will eventually run in.

### Expected merge conflict zones

- MEDIUM: `runFullCli()`/`spawnFullCli()` and the trailing dispatch in `packages/coding-agent/src/cli.ts`.
  Upstream owns this entrypoint and reshapes it periodically; a conflict here should be resolved by
  re-applying the `requiresIsolatedProcess()` branch around whatever spawn body upstream ends up with,
  keeping the spawn path unchanged.
- LOW: the `hasInheritedInspectorOption` export in `packages/coding-agent/src/inspector-policy.ts`
  (export keyword only; the function body is untouched).
- LOW: the `enableStartupCompileCache()` call comment in `cli.ts`, shared with the compile-cache entry
  below.

## Node module compile cache for CLI startup (2026-08-20)

### What changed

- `packages/coding-agent/src/compile-cache.ts` (new, fork-only): `enableStartupCompileCache()` enables
  Node's on-disk V8 module compile cache and publishes the resolved BASE cache directory into
  `process.env.NODE_COMPILE_CACHE` so child processes inherit the same cache. Node's programmatic
  `enableCompileCache()` does not export that variable itself, and the value published must be the base
  directory (not `getCompileCacheDir()`, which already contains Node's versioned segment — handing it
  back double-nests the child's cache and it misses every parent entry). The API is read off the
  `node:module` namespace rather than imported by name: a named import of a missing export is a
  link-time `SyntaxError` no runtime guard can catch, and the bun-compiled binary runs this file.
- `packages/coding-agent/src/cli.ts` calls it as the first statement after imports (after the existing
  `valid-cwd.ts` first-import guard): `cli.ts` spawns `cli-main` as a child, and that child loads the
  full engine graph, so inheritance is what makes the cache reach the process that pays the compile cost.
- `packages/coding-agent/src/cli-main.ts` calls it first as well, so direct `cli-main` invocations (the
  bun binary, tests) benefit when no launcher published a directory; when one did, the call keeps the
  existing value.
- Guards: never overrides a pre-set `NODE_COMPILE_CACHE`; `NODE_DISABLE_COMPILE_CACHE=1` stays honored
  (the call is skipped or Node reports failure and nothing is published); any failure degrades to plain
  compilation instead of failing startup.

### Why

- Cold profiling attributes roughly a quarter of CLI boot CPU to V8 compiling the ~800ms module graph;
- with the cache warm, repeated launches skip that compilation. Measured on this fork's built dist
  (Apple M4 Pro, node v26.7.0): `cli-main --help` user CPU -11% to -14%, net user+sys -3% (the cache
  read IO eats part of the compile saving; wall-clock gains appear on an otherwise idle machine).
- The first launch after enabling still compiles and writes the cache (cache population), so this is a
  warm-start optimization only.

### Why an extension could not handle it

- The cache must be enabled before the engine's module graph starts loading, and `NODE_COMPILE_CACHE`
  must be in the environment before `cli.ts` spawns the `cli-main` child — both happen in the
  entrypoints, before the extension loader exists.

### Expected merge conflict zones

- LOW: the first-statement call and its import in `cli.ts` and `cli-main.ts` (upstream may reshuffle
  entrypoint imports; the `valid-cwd.ts` first-import ordering is pinned by test and must stay first).
  `compile-cache.ts` is fork-only with no upstream counterpart.

## Entry surface and CLI coordinator re-diverge from upstream 59a71b23 (2026-08-19)

### What changed

- `packages/coding-agent/src/index.ts` keeps the fork's wider public surface after the sync to upstream
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`: it re-exports `sanitizeTerminalLabel` from
  `@earendil-works/pi-tui`, the `OAuthCredential` type from `core/auth-storage.ts`, and the fork-only extension
  contracts `ExtensionRpcRequestHandler`, `FilesystemOperation`/`FilesystemPolicy`/`FilesystemPolicyChecker`/
  `FilesystemPolicyDecision`/`FilesystemPolicyRequest`, `InputDispositionEvent`, and `McpServerDeclaration`, plus
  the RPC client event types `RpcClientEvent` and `RpcExtensionEvent`.
- `packages/coding-agent/src/main.ts` keeps the fork startup coordinator on top of upstream's version: the
  `app-server` app mode and `handleAppServerCommand()` dispatch (with `toProjectTrustMode()` mapping it to the
  `print` trust mode), the `--multi-session` plain-RPC host (which pre-calls `initTheme()` because
  `runMultiSessionHost()` never returns), `--list-tips`, the codex-style startup loading indicator paused around
  project-trust prompts, `--grok-neo` chrome selection with the non-persistent `grok-night` theme fallback,
  branded `envValue("OFFLINE")`/`envValue("STARTUP_BENCHMARK")` reads and `DISPLAY_VERSION`, `--list-models`
  resolved from services before the runtime is built, auth-storage diagnostics drained per phase,
  `initialTitlePrompt`/auto-title wiring, `initialModelProvenance`/`thinkingSelection` propagation, the
  `promptConfirm()` stdin-EOF close handler, and the non-interactive fail-fast for cross-project session forks.

### Why

- These are fork product surfaces (app-server transport, multi-session RPC host, senpi branding and version
  display, grok chrome, tips, model provenance) that upstream does not ship; the merge with the new pin restores
  upstream's leaner entry point around them, so the files remain divergent by design after the pin advance.

### Why an extension could not handle it

- Both files run before any extension exists: `index.ts` is the module surface extensions import, and `main.ts`
  parses argv, resolves trust, and constructs the runtime that later loads extensions.

### Expected merge conflict zones

- MEDIUM: `main.ts` `main()` startup ordering (list-models/list-tips early exits, loading indicator, runtime
  factory) and `resolveAppMode()`/`createSessionManager()`; LOW: the alphabetized export blocks in `index.ts`.

## 2026-08-18 - Cursor reasoning-level startup wiring

### What changed

- `packages/coding-agent/src/main.ts`: startup carries the resolved thinking selection (CLI `--thinking`,
  `:suffix` model patterns, favorites, legacy cursor variant ids) into session state so the first turn's
  provider request encodes the user's actual choice.

### Why

- Cursor models encode reasoning on the wire; a defaulted level must not be mistaken for an explicit one.

### Why an extension could not handle it

- CLI argument resolution and initial session construction are core startup surfaces.

### Expected merge conflict zones

- `main.ts` model/thinking option resolution block.

## Repository audit baseline for the src tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`, tag v0.84.2). It assigns every audited production path whose exact
  nearest tracker is this file, so the audit gate resolves each divergence even where the per-feature history below
  predates the gate. `packages/coding-agent/src/cli.ts` and `packages/coding-agent/src/main.ts` are already covered by
  dated entries below.
- Entrypoints: `packages/coding-agent/src/bun/cli.ts` (Bun-binary entry now loads the full bootstrap and registers the
  cursor-agent module), `packages/coding-agent/src/rpc-entry.ts` (RPC entry scrubs the brand environment and exports
  the branded `AI_AGENT` identity).
- Brand and config resolution: `packages/coding-agent/src/config.ts` — brand-profile consumption for identity constants,
  flat-layout agent-directory resolution with nearest-parent discovery, brand-scoped environment reads, and the Bun
  self-update launcher-repair step (own entry below).
- Startup migrations: `packages/coding-agent/src/migrations.ts` — brand engine-state copy-forward plus the fork
  extension-system and legacy-directory migrations replacing upstream's inline commands-to-prompts path (own entry
  below).
- Public surface: `packages/coding-agent/src/index.ts` re-exports the extension RPC handler, filesystem-policy,
  input-disposition, MCP-declaration, and RPC-client event types; `packages/coding-agent/src/modes/index.ts`
  re-exports `RpcClientEvent` and `RpcExtensionEvent`.
- Mode and client deltas: `packages/coding-agent/src/modes/print-mode.ts` (one-shot prompts pass
  `sessionTitlePrompt: false`, the final assistant message is selected with `findLast` so trailing non-assistant
  entries cannot mask it, provider-native content renders in text mode, and the run waits for settled session work
  before exiting), `packages/coding-agent/src/client/transcript.ts` (equivalent optional-chaining guard on transcript
  progress application), `packages/coding-agent/src/package-manager-cli.ts` (branded `update`/`list`/`config` help
  surface, brand update-channel redirect that defers to the parent package, and the removable omo-local-update beta
  worker flag).
- Local provider: `packages/coding-agent/src/extensions/llama/provider.ts` keeps sleeping llama.cpp runners
  discoverable (own entry below).

### Why

- The pre-backfill audit reported these paths uncovered: the entries that described them either predate the canonical
  four-section format or never named the exact path. This inventory closes that gap without rewriting the accurate
  per-feature history below.

### Why an extension could not handle it

- Tracker coverage is repository and release policy, not runtime behavior; it is enforced by repository scripts before
  any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker file merges to `ours` on upstream sync; the inventory intentionally names pin-relative paths so
  it stays valid as entries below change.

## Brand profile, config-directory resolution, and engine-state migration (2026-08-17)

### What changed

- `packages/coding-agent/src/config.ts`: consumes a `BrandProfile` injected once per process — `APP_NAME`, `APP_TITLE`,
  and `CONFIG_DIR_NAME` resolve the brand ahead of the package's `piConfig` metadata, `DISPLAY_VERSION` separates the
  brand-facing version from the engine `VERSION` used for update comparisons, `CONFIG_FLAT_LAYOUT` marks brands that
  keep agent state directly under the config directory, and `ENV_PREFIX` builds `ENV_AGENT_DIR`/`ENV_SESSION_DIR`
  while legacy prefixes stay readable.
- `packages/coding-agent/src/config.ts`: environment reads go through brand-scoped `envValue()` (`PACKAGE_DIR`,
  `SHARE_VIEWER_URL`, `CODING_AGENT_DIR`) instead of raw `PI_*` literals; `resolveAgentDir()` adds nearest-parent
  config discovery with a flat-layout `settings.json` sentinel; Bun self-update composes a launcher-repair step and
  binary-download guidance points at the senpi releases page.
- `packages/coding-agent/src/migrations.ts`: `runMigrations()` runs `migrateEngineStateForBrand()` first — a
  copy-forward (never a move) of the engine's `~/.senpi/agent` state into a flat-layout brand directory, guarded by
  the `.migrated-from-senpi` marker and skipping regenerable entries — then the fork's `migrateLegacySenpiDirs()` and
  `migrateExtensionSystem()`, replacing upstream's inline commands-to-prompts and deprecated-directory checks that
  now live in `extension-system-migration.ts`.

### Why

- A rebranded distribution reads different config and state locations than the engine install it replaces; resolving
  them once keeps every downstream consumer brand-correct, and copying (not moving) engine state keeps a standalone
  engine install on the same machine intact.
- Environment prefixes and display versions are brand identity, not feature behavior, so they must not be hardcoded
  per call site.

### Why an extension could not handle it

- Config-path, brand, and environment resolution happen at module load and bootstrap, before the extension loader
  exists; startup migrations run once over directories extensions never see.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/src/config.ts` identity constants and `resolveAgentDir()`.
- MEDIUM: `packages/coding-agent/src/migrations.ts` `runMigrations()` ordering; upstream may reshape its own
  command/prompt migrations.

## Split CLI bootstrap: thin launcher, full engine child, branded entries (2026-08-17)

### What changed

- `packages/coding-agent/src/cli.ts` is now a thin bootstrap: it imports the deleted-cwd guard first, answers
  `--version`/`-v` directly from `DISPLAY_VERSION` without loading the engine, detects package-manager subcommands,
  and when a package-manager install is missing its bundled workspace dependencies routes through the bootstrap
  self-update handler before spawning the full CLI as a child process with the parent's `execArgv`, propagating the
  child's exit signal.
- `packages/coding-agent/src/cli-main.ts` is the relocated full bootstrap (early inspector-import recovery, brand
  scrubbing, `PI_CODING_AGENT` marker, HTTP dispatcher configuration) that awaits `main()`.
- `packages/coding-agent/src/bun/cli.ts` registers Bun OAuth flows, restores the sandbox environment, registers the
  Bedrock and cursor-agent modules, then loads the full bootstrap instead of the thin launcher.
- `packages/coding-agent/src/rpc-entry.ts` keeps its dedicated RPC dispatch but now scrubs the brand environment and
  sets `AI_AGENT` to `APP_NAME` instead of the hardcoded engine name.

### Why

- A broken or half-updated global install must offer a self-repair path instead of dying on module resolution, and
  version or package-manager queries should not pay full engine startup. RPC host processes need their own process
  identity and a clean brand environment so nested engine runs keep the engine's identity.

### Why an extension could not handle it

- These are pre-runtime entrypoints: extensions load only after `main()` has bootstrapped settings and the resource
  loader, so no extension can restructure process spawning, environment scrubbing, or self-repair.

### Expected merge conflict zones

- HIGH: `packages/coding-agent/src/cli.ts` was substantially rewritten relative to upstream's direct `main()` call.
- MEDIUM: `packages/coding-agent/src/cli-main.ts` bootstrap ordering.
- LOW: the registration lines in `packages/coding-agent/src/bun/cli.ts` and the identity lines in
  `packages/coding-agent/src/rpc-entry.ts`.

## Deleted-cwd bootstrap guard (2026-08-17)

### What changed

- New fork-only first-import guard `packages/coding-agent/src/valid-cwd.ts`: when the shell's working directory no
  longer exists (a removed worktree or checkout), it changes to the home directory with a stderr notice before any
  other module loads. `packages/coding-agent/src/cli.ts` and `packages/coding-agent/src/cli-main.ts` import it as
  their first statement.

### Why

- Node boots with a stale cwd handle and only throws `uv_cwd` when something evaluates `process.cwd()`; the bundled
  agent SDK does that during module evaluation, before user code could recover, so a deleted cwd crashed the CLI at
  import time with no guidance.

### Why an extension could not handle it

- The guard must run before every other import, including the SDK's module evaluation; the extension loader does not
  exist yet.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/valid-cwd.ts` is fork-only; the first-import lines in the entrypoints may conflict
  with upstream import reshuffles.

## llama.cpp local provider keeps sleeping runners discoverable (2026-08-17)

### What changed

- `packages/coding-agent/src/extensions/llama/provider.ts`: the router-fed `setCatalog()` keeps models whose runner
  status is `loaded` OR `sleeping`, because the llama.cpp router wakes sleeping runners on demand; the persisted
  `refreshModels()` snapshot still filters to `loaded` only. Credential resolution accepts a stored server URL, the
  `LLAMA_BASE_URL` environment, or the default local server, with an optional API key.

### Why

- A model whose runner was asleep but wakeable disappeared from the model list, so users could not select exactly
  the local models the router exists to wake on demand.

### Why an extension could not handle it

- The provider is a builtin registered with the model runtime; catalog filtering happens inside the provider's own
  model snapshot, which the runtime reads before any extension can post-process it.

### Expected merge conflict zones

- LOW: the status filter in `setCatalog()` and the credential-resolution chain.

## APP_NAME process identity and first-prompt session titles (2026-08-17)

### What changed

- Process identity is derived from the resolved brand: `process.title` is `APP_NAME` in `packages/coding-agent/src/cli.ts`,
  `packages/coding-agent/src/cli-main.ts`, and `packages/coding-agent/src/bun/cli.ts`, and `${APP_NAME}-rpc` in
  `packages/coding-agent/src/rpc-entry.ts`; `AI_AGENT` and inherited brand environment variables are set or scrubbed
  per entrypoint so nested engine runs keep the engine's own identity.
- Session titles: `buildInitialMessage()` in `packages/coding-agent/src/cli/initial-message.ts` returns the first CLI
  message as `initialTitlePrompt` when the initial prompt carries no private context (no piped stdin, no `@file` text,
  no attached images); `main.ts` threads it into interactive mode, which passes it as `sessionTitlePrompt` so the
  session is titled from the user's actual prompt. One-shot print mode passes `sessionTitlePrompt: false` instead.

### Why

- Process lists, logs, and RPC host spawns must distinguish branded runs (and RPC hosts) from the upstream engine,
  and an auto-generated title that ignored a plain first prompt produced generic titles for the most common launch
  shape.

### Why an extension could not handle it

- `process.title`, brand scrubbing, and argv-to-options wiring all execute in the entrypoints before the extension
  loader exists; the title prompt must be captured before the session consumes the initial message.

### Expected merge conflict zones

- LOW: per-entrypoint title and environment lines; the `sessionTitlePrompt` threading in `main.ts` and interactive
  mode.

## Retry-exhausted provider timeouts release retained steering (2026-08-17)

### What changed

- `core/agent-session.ts`: when a managed provider-timeout retry exhausts its retry/fallback budget, the retry owner
  now hands steering or follow-up input that was deliberately deferred from the retry request to the existing
  scheduled-continuation path. Successful retries keep their current queue behavior, and generic terminal
  provider errors or aborts still park queued work.
- Queue ownership follows the retry continuation that actually deferred the queue (recorded when the
  provider-timeout retry plan schedules its continuation), not the class of the final error: a timeout retry that
  ends in a different retryable failure still releases its deferred queue, while late steering queued during an
  ordinary non-deferring retry stays parked. User aborts — in flight or during the retry backoff sleep — keep
  retained input parked; a cancelled backoff reports a distinct outcome from budget exhaustion.
- Coverage: `test/suite/regressions/provider-idle-steering.test.ts` proves a provider timeout, one failed managed
  retry, and a steer queued during `auto_retry_start` produce an automatic third request without another prompt.
  `.agents/skills/senpi-qa/scripts/mock-loop-stream-start-timeout-steering.mjs` drives the same sequence through the
  real RPC CLI and actual stream-start watchdogs.

### Why

- Provider-timeout retries use `deferQueuedMessages: true` so steering cannot be consumed by another retry request
  that has not demonstrated responsiveness. If that retry also failed and no fallback remained, the generic Agent
  terminal-error policy correctly parked the queue, but the coding-agent retry owner had already finished and no
  lifecycle owner remained to admit it. The queued message therefore ran only after an unrelated later prompt.

### Why an extension could not do this

- Retry attempt accounting, provider-timeout continuation options, terminal `agent_end` admission, compaction
  revalidation, and queued-message ownership are coordinated inside `AgentSession` before extension callbacks can
  safely claim or release the queue.

### Expected merge conflict zones

- HIGH: `core/agent-session.ts` around `_processAgentEvent()` retry/compaction continuation admission.
- LOW: additive coverage in `test/suite/regressions/provider-idle-steering.test.ts` and the Senpi QA scenario.

## Custom-editor submit callbacks preserve the authoritative value (2026-08-16)

### What changed

- `modes/interactive/interactive-mode.ts` now routes custom-editor submissions through `expandSubmittedText()`.
- The submit helper preserves a non-empty `getExpandedText()` result from editors that submit before clearing, but uses the callback text when the live editor has already been cleared by pi-tui.
- The real host bridge is covered in `test/suite/regressions/0000-editor-paste-submit.test.ts` for clear-before-callback, retained paste-state expansion, and uncleared custom-editor compatibility.

### Why

- pi-tui computes the submitted value, clears editor and paste state, then invokes `onSubmit`. Re-reading the cleared editor returned `""`, so Enter cleared the prompt without sending a message.

### Why an extension could not do this

- The host owns the callback bridge between extension-provided editors and the default submission handler.

### Expected merge conflict zones

- LOW: `modes/interactive/editor-paste-transfer.ts`, the `setCustomEditorComponent()` submit callback, and its focused regression suite.

## CLI system-prompt overrides rewired into the runtime resource loader (2026-08-17)

### What changed

- `main.ts`: the runtime `resourceLoaderOptions` again forwards `parsed.systemPrompt` / `parsed.appendSystemPrompt` to `DefaultResourceLoader`, re-enabling the documented `--system-prompt` / `--append-system-prompt` flags on the CLI path (the SDK path already honored loader overrides).

### Why

- Commit `0ce8ac312` (2026-07-19, "preserve dynamic prompt policy") disconnected the flags because the prompt-preset extension clobbered user overrides on preset-matching models. The preset extension now yields to a user custom prompt and reapplies user appends (see `core/extensions/builtin/prompt-preset/changes.md`), so the flags can compose with the dynamic prompt policy instead of fighting it.

### Why extension system couldn't handle this

- CLI argv-to-loader wiring is host bootstrap code; extensions load after the resource loader exists.

### Expected merge conflict zones

- LOW: `main.ts` runtime `resourceLoaderOptions` block — keep both fields when upstream reshapes the options.

## JSONC settings selection and source events (2026-08-16)

### What changed

- Settings loading now accepts dependency-free JSONC syntax (line/block comments outside strings and trailing commas) in both `settings.jsonc` and existing settings content.
- Each global/project config directory prefers `settings.jsonc` over `settings.json`; the selected path remains the write target until the next explicit reload selection.
- `AgentSessionEvent` gained `settings_source_selected` with `{ path, format, reason, scope }`. Current selections replay once to newly attached host listeners, and reload selections publish through the normal session emitter.
- The config-reload builtin watches and validates both settings filenames with the same parser.

### Why

- Users need commented settings without losing plain-JSON compatibility, deterministic precedence, or having a UI write silently create the other file flavor.
- RPC and interactive hosts need an authoritative source decision instead of inferring it from filesystem state.

### Why an extension could not do this

- Settings path selection, parse-before-runtime, merge-before-write, and session listener attachment all occur in core before an extension can replace them. The built-in config watcher also owns reload admission and validation.

### Expected merge conflict zones

- HIGH: `core/settings-manager.ts` around path resolution, storage locking, load/reload, and merge-before-write parsing.
- MEDIUM: `core/agent-session.ts` event union, subscription replay, and disposal.
- LOW: additive host handling under `modes/rpc/` and `modes/interactive/`, plus config-reload filename allowlists/validation.

## Unified lockfile staleness policy across auth and settings storage (2026-08-16)

### What changed

- `core/lockfile-policy.ts` exports `FILE_STORAGE_LOCK_OPTIONS` (`stale: 30_000`, `update: 10_000`, `realpath: false`)
  and both file-backed stores acquire proper-lockfile locks with it: `FileAuthStorageBackend` sync and async paths in
  `core/auth-storage.ts` and `FileSettingsStorage` in `core/settings-manager.ts`. Lock file locations and read/write
  semantics are unchanged.
- Coverage: `test/lockfile-policy.test.ts` captures the options each backend passes to `lockSync`/`lock` and asserts
  all three acquisitions report the identical policy.

### Why

- Proper-lockfile defaults to `stale: 10_000` and refreshes a held lock's mtime every `stale / 2` ms. The async auth
  path used `stale: 30_000` (15s refresh) while both sync paths kept the 10s default, so a sync contender could
  classify a still-live async lock as stale in the 10-15s window and steal it mid-update.

### Why an extension could not do this

- Lock acquisition options are hardcoded inside core storage backends; an extension cannot intercept or reconfigure
  the proper-lockfile calls used by credential and settings persistence.

### Expected merge conflict zones on next upstream sync

- `core/auth-storage.ts` and `core/settings-manager.ts`, around the lock acquisition helpers.

## Non-interactive auth reads degrade on storage lock failures (2026-08-16)

### What changed

- `core/auth-storage.ts`: asynchronous credential reads now preserve the last valid in-memory snapshot when acquiring
  or reading the auth storage lock fails, regardless of whether the caller supplied an operation signal. The failure is
  retained in `AuthStorage.drainErrors()`; an actual caller abort still rejects instead of being converted into stale data.
- `main.ts`: non-interactive startup/model-listing and completed print runs drain auth-storage failures through the
  existing warning diagnostic renderer. Interactive-mode reporting is unchanged.
- OAuth refresh persistence remains fail-closed because `modify` and `delete` still propagate every lock, parse, and
  write failure without fallback.

### Why

- Model-runtime credential reads always carry a normalized signal. The previous signal-gated branch therefore skipped
  its intended last-good fallback, so a sandbox-denied `auth.json.lock` mkdir escaped top-level `senpi -p` startup as an
  uncaught `EPERM` instead of a warning.
- Corrupt auth data must remain visible even when the last-good snapshot keeps a non-interactive run alive, so degraded
  reads record the original failure for the CLI diagnostic surface.

### Why an extension could not do this

- Credential storage locking and the non-interactive bootstrap diagnostic boundary run inside core before an extension
  can intercept model authentication or recover a rejected credential-store read.

### Expected merge conflict zones on next upstream sync

- `core/auth-storage.ts`, around `readLatestData` reload coalescing and abort handling.
- `main.ts`, around startup diagnostics and print-mode dispatch.


## Idempotent ambient OAuth auth composition (2026-08-14)

### What changed

- `core/provider-api-key-auth.ts` now accepts an ambient OAuth resolver's own synthetic key when resolved auth is replayed as an explicit request key by title, compaction, and branch-summary calls.
- The compatibility adapter identifies itself as ambient-only, so a replayed marker or unrelated explicit key cannot bypass a valid stored OAuth account.
- The ambient adapter now resolves configured metadata headers and `authHeader` through the same composition used by stored OAuth.
- Replay-only credential environment participates in configured header resolution while unrelated explicit keys remain rejected.
- Present-but-empty Claude token slots survive synthetic-marker replay, preventing auxiliary calls from falling back to a host token.
- When any request Claude token slot is present, ambient resolution treats that request token set as the complete namespace and cannot import a different host slot during replay.
- Request-backed `config-dir` authentication uses the non-persisting OAuth environment lane for that request, so request credentials are never written below the stable agent directory.
- Coverage compares ambient and stored OAuth auth shapes, drives replay through real title generation, and pins stored-account precedence.

### Why

- Auxiliary calls copy resolved request auth into their own options. Rejecting the provider's marker made the second auth pass report unconfigured, while allowing the ambient adapter to outrank stored OAuth broke managed-account replay and an early ambient return dropped configured headers and synthesized authorization.

### Why an extension could not do this

- Provider auth composition runs before request hooks and is the mechanism that makes extension-registered providers callable. An extension cannot repair auth that the host composer rejected or omitted.

### Expected merge conflict zones on next upstream sync

- LOW: `core/provider-api-key-auth.ts` around the ambient-only OAuth adapter and its precedence metadata.


The historical-image transport entry moved to `core/changes.md`, beside the
other provider-bound image transport behavior that owns the same payload path.

## GLM 5.3 full support: preset + catalog + wire (2026-08-16)

### What changed

- `core/extensions/builtin/prompt-preset/`: new `glm-5-3.ts` preset (clone of `glm-5-2.ts`), `presets.ts` matcher + dispatch, `settings.ts` union entry. The preset carries "running on GLM 5.3" tuning; every behavioral directive is identical to 5.2.
- `packages/ai`: `openai-completions.ts` generalized `isGlm52`→`isGlm5x` (5.3 inherits 5.2's thinkingLevelMap branches) and forces zai `{type:"enabled"}` for 5.3 even without reasoning effort. 25 glm-5.3 catalog entries cloned across 18 provider data files. `generate-models.ts` updated so regeneration preserves 5.3.
- Tests: `test/suite/prompt-presets-glm-5-3.test.ts` (preset resolution + catalog sweep), `packages/ai/test/glm-5.3-thinking.test.ts` (reasoning effort map + zai always-enabled).

### Why

- GLM 5.3 shipped in upstream catalogs (oh-my-pi's `zai` provider defaults to `glm-5.3`) but senpi had zero 5.3 support: no preset, no catalog entries, no wire-level reasoning effort handling. Users selecting GLM 5.3 got the untuned fallback prompt and unmapped reasoning effort.

### Expected merge conflict zones

- `prompt-preset/presets.ts`/`settings.ts`: shared lists — trivial adjacent-line conflicts if upstream adds presets.
- `openai-completions.ts`: the `isGlm52`→`isGlm5x` rename and zai handler guard sit in fork-modified sections.
- Provider data files: fork-only; upstream has no counterpart.

## Explicit `/skill:` invocations retain user authority (2026-08-16)

### What changed

- `core/agent-session.ts`: each known leading `/skill:<name>` expansion now states that the user explicitly invoked that
  skill, places its binding workflow in a `<skill-instruction>` section, and isolates trailing free text in a
  `<user-request>` section. Chained skills retain written order; unknown-skill fallthrough, duplicate suppression, and
  the five-skill expansion cap are unchanged. `parseSkillBlock` recognizes that current format first and retains its
  legacy `<skill>` fallback so resumed and imported sessions still collapse correctly.
- `core/export-html/template.js`: the intentionally standalone parser mirrors the runtime parser, preserving collapsed
  skill rendering in exported transcripts for both current and legacy session payloads.
- Coverage: `test/suite/agent-session-prompt.test.ts` pins invocation shape with and without trailing arguments and for
  chained skills; `test/suite/regressions/308-skill-composition.test.ts` keeps unknown-skill, cap, deduplication, steer,
  and follow-up behavior pinned to the new shape; `test/export-html-skill-block.test.ts` executes both parsers against
  payloads from the production formatter and covers chained and legacy messages; the real-expansion hook test confirms
  `UserPromptSubmit` context injection preserves the new wrapper and request.

### Why

- The previous expansion flattened passive `<skill>` content and trailing arguments into one ordinary user message.
  That erased the user's explicit command authority, allowing the Intent Gate to route only on the trailing prose and
  ignore the selected skill's rules or workflow (issue #890).

### Why an extension could not do this

- Skill-command expansion happens in the private `AgentSession` prompt, steering, and follow-up dispatch paths before
  the provider sees the user message. Extensions cannot replace that text transformation consistently across all three
  paths.

### Expected merge conflict zones on next upstream sync

- `core/agent-session.ts` around skill invocation formatting, parsing, and `_expandSkillCommand`.
- `core/export-html/template.js` around the standalone `parseSkillBlock` copy.
- `test/export-html-skill-block.test.ts`, `test/suite/agent-session-prompt.test.ts`, and
  `test/suite/regressions/308-skill-composition.test.ts` where parsing and the exact expanded payload are pinned.

## Shipped Fable fallback chain reaches Kimi K3 served as `kimi-k3` (2026-08-13)

### What changed

- `core/retry-fallback/settings.ts`: `DEFAULT_FALLBACK_CHAINS["claude-fable-5"]` gains a bare `kimi-k3:max` entry after
  `k3:max`, so providers that expose Kimi K3 under the vendor-prefixed id `kimi-k3` (OpenCode Go) join the shipped
  Fable -> K3 fallback route. `matchesFamily` is untouched: the conservative exact/dash-suffix matcher still cannot
  capture `kimi-k3` via `k3`, which is why the alias is an explicit entry rather than a matcher change (issue #793).
- Coverage: `test/suite/retry-fallback-expansion.test.ts` (new alias expansion case + shipped-default pin),
  `test/settings-manager-retry-fallback.test.ts` and `test/suite/retry-fallback-chains.test.ts` (shipped-default pins),
  and the real-CLI scenario `.agents/skills/senpi-qa/scripts/scenarios/fallback-chains-kimi-k3-qa.mjs`.

### Why

- On registries serving `opencode-go/kimi-k3`, `/fallback` expanded the shipped Fable chain to Claude entries only:
  `k3` matches `k3`/`k3-*` but never `kimi-k3`, so OpenCode Go users lost the intended Fable -> K3 route.

### Why an extension could not do this

- The shipped defaults are core policy consumed by `canonicalizeFallbackChains`; an extension can replace a chain per
  key but cannot amend the shipped default's entries without owning the whole key.

### Expected merge conflict zones on next upstream sync

- `core/retry-fallback/settings.ts` (`DEFAULT_FALLBACK_CHAINS` literal).
- The three test files pinning the shipped chain contents/length.

## Provider stream stalls share the bounded retry policy (2026-08-13)

### What changed

- `core/agent-session.ts`: provider-stream stalls (`isProviderStreamStallError`, covering both the idle-timeout and
  stream-start-timeout watchdog wordings) are no longer special-cased. They consume the same bounded same-model retry
  budget (`settings.retry.maxRetries`) as every other transient class and escalate to the fallback chain only when that
  budget is exhausted. The `_consecutiveProviderStreamStalls` streak counter and its escalation branch are removed.
- `core/provider-timeout-retry.ts`: the retry request keeps the configured `timeoutMs`/`streamStartTimeoutMs` instead of
  clamping both to `retry.provider.streamRetryTimeoutMs`. That setting still bounds the retry *continuation*
  (`runBoundedRetryContinuation`), so a wedged retry is still cancelled without shortening the provider's own guards.
  Disabled guards are still never re-enabled.
- Coverage: `test/suite/retry-fallback-stall-shared-budget.test.ts` (replaces
  `test/suite/retry-fallback-stall-escalation.test.ts`), `test/provider-timeout-retry.test.ts`, and updated
  `test/suite/regressions/provider-idle-{recovery,steering}.test.ts`.

### Why

- This reverses the 2026-07-29 stall-escalation and retry-cap entries below. In practice the two combined to end turns
  early: the second consecutive stall skipped the remaining same-model budget, so a session with no configured fallback
  chain surfaced `Retry failed after 1 attempts: Provider stream start timed out after 30000ms` while `maxRetries` was 3.
- The cap also shrank a configured 90s stream-start guard to 30s on the retry, so the retry was judged dead on a deadline
  the operator never configured - visible as a 90000ms stall immediately followed by a 30000ms one. A slow-but-alive
  provider now gets the budget it was configured with, and the transient class it already belongs to
  (`isRetryableErrorMessage` matches both wordings) decides the number of attempts.

### Why an extension could not do this

- Retry classification, the same-model budget, and the fallback-chain handoff all live in the private auto-retry branch of
  `AgentSession`. No extension hook observes or replaces that decision.

### Expected merge conflict zones on next upstream sync

- `core/agent-session.ts` in the transient retry branch (`_autoRetry`) around the budget/fallback gate.
- `core/provider-timeout-retry.ts` in `createProviderTimeoutRetryPlan`.

## Model-aware `/btw` side-query context budgeting (2026-08-12)

### What changed

- `/btw` side queries now budget the complete ephemeral prompt against the selected model's context window. Oversized
  snapshots reuse the deterministic context reducer, repair orphaned tool results, and prune oldest context while
  preserving the final question and newest usable messages.
- Mandatory prompt content that still cannot fit now fails locally with an actionable `/compact` suggestion instead of
  sending a provider request that is guaranteed to be rejected.

### Why

- The builtin `/btw` path bypassed the main-turn context pipeline and replayed the captured session snapshot directly to
  the provider. Large sessions could therefore fail with a context-window overflow even while the main turn continued.

### Why an extension could not do this

- The oversized payload is assembled inside the builtin command's private snapshot-to-provider path. An external
  extension cannot intercept and structurally budget that ephemeral request without replacing the builtin.

### Expected merge conflict zones on next upstream sync

- `core/extensions/builtin/btw/index.ts` around snapshot construction and side-query dispatch.
- `core/extensions/builtin/btw/side-query.ts` around context assembly and model runtime options.
- `test/suite/btw-side-query.test.ts` around context-builder and command regression coverage.

## Control protocol exposes loaded extensions and MCP inventory (2026-08-11)

### What changed

- RPC gained the session-scoped `get_loaded_surfaces` request. Extension rows come from
  `resourceLoader.getExtensions().extensions`, so commandless extensions remain visible and multi-command extensions
  appear once; skills remain one-row-per-skill through `get_commands`.
- MCP rows come from the live session-owned MCP service and report server name, tool count, connection/config status,
  and non-secret auth status. A session-local event-bus bridge preserves multi-session isolation instead of consulting
  the classic process singleton.
- RPC emits `loaded_surfaces_changed` when the loaded skill, extension, or MCP snapshot changes. The event is an
  invalidation notice with no payload, matching the app-server `skills/changed` read-after-notify model.

### Why this cannot be expressed externally

- The control host owns session routing and response/event ordering, while the loaded extension inventory and scoped
  MCP service are private runtime state. An extension cannot add a correlated control request or safely address another
  session's service.

### Expected merge conflict zones

- MEDIUM: additive request/event handling in `modes/rpc/rpc-types.ts` and `connection-handler.ts`.
- LOW: the MCP control-inventory bridge and wire-status refresh hooks under `core/extensions/builtin/mcp/`.

## Fallback responses with errors no longer emit success (2026-08-11)

### What changed

- `core/agent-session.ts` now requires an assistant response to have no `errorMessage` before it emits
  `retry_fallback_succeeded` and `auto_retry_end { success: true }`.
- A fallback provider response such as `Not logged in · Please run /login` can no longer produce the green
  `Fallback model responded` notice merely because its stop reason was not normalized to `error`.
- A terminal errored fallback response also closes the active retry attempt with `auto_retry_end { success: false }`,
  so a later successful user turn cannot emit a delayed success notice for the earlier failed fallback.

### Why this cannot be expressed externally

- Retry-attempt settlement and `retry_fallback_succeeded` emission occur inside private `AgentSession` lifecycle
  state before extensions or interactive renderers can correct the classification.

### Expected merge conflict zones

- LOW: the assistant `message_end` success gate in `core/agent-session.ts`.
- LOW: the focused hard-error fallback cases in `test/suite/retry-fallback-hard-error.test.ts`.

## Public filesystem policy exports (2026-08-09)

### What changed

- The package root now exports the filesystem policy request, operation, decision, policy, and composed-checker types
  used by `pi.registerFilesystemPolicy()` consumers.

### Why this cannot be expressed externally

- Extension source compiles against the package's public type surface; an extension cannot export missing host API
  declarations for itself.

### Expected merge conflict zones

- LOW: the extension type export lists in `src/index.ts` and `core/extensions/index.ts`.

## `--session` cross-project resume fails fast instead of hanging on non-interactive stdin (2026-08-07)

### What changed

- `src/main.ts`: when `--session <id>` resolves to a session owned by a different project, the CLI previously always asked `Fork this session into current directory?` via readline. With piped, detached, or closed stdin (scripts, app-server spawns) the question never settles — readline does not answer on EOF — so the process hung forever with no output. `createSessionManager()` now receives the resolved `AppMode` and exits 1 with an actionable message (`--fork '<id>'` or re-run interactively from the owning project) for every non-interactive mode. Gating on `process.stdin.isTTY` alone was not enough: a `-p` one-shot launched from an ordinary terminal has TTY stdin, so it still reached the prompt and blocked.
- `promptConfirm()` additionally resolves `false` on readline `close` (Ctrl+D / stdin EOF) so interactive sessions can no longer wedge on an ended input stream.
- Coverage: `test/suite/regressions/756-session-cross-project-resume.test.ts` spawns the real CLI against a cross-project session fixture for both shapes — non-terminal stdin, and a `-p` run booted with the TTY flags a terminal sets — and asserts the fast, guided failure with bounded child teardown.

### Expected merge conflict zones on next upstream sync

- LOW: additive branch and close-handler only, both inside fork-owned `main.ts` session wiring.

## Joined user aborts override system provenance (2026-08-05)

### What changed

- `AgentSession` now promotes an in-flight system-owned abort to user-owned when
  an explicit user abort joins the same operation.
- Joining an existing abort awaits the shared promise without issuing a second
  `agent.abort()` call, and a later system abort cannot downgrade user provenance.
- A later recovery generation with no active provenance issues its own
  `agent.abort()` and records a fresh source instead of incorrectly joining the
  prior generation's completed abort.
- User intent that arrives while `agent_end` handlers are dispatching promotes
  the shared event in place. A late join that occurs after an earlier handler
  already observed system provenance emits one `session_abort` before
  `agent_settled`, so TTSR corrective follow-ups and provider retries admitted
  before dispatch cannot outrun the user cancellation.
- The same cancellation boundary remains open through the public `agent_end`
  notification, covering Escape handlers that run after extension dispatch but
  before retry and settlement processing.
- The boundary now remains mutable through `agent_settled` dispatch as well.
  Extension messages requested from that event are held by
  `agent-settled-delivery.ts` until every handler and public listener completes;
  a user abort drops the held actions before one can become a corrective
  provider turn, without disturbing user-owned steering or follow-up queues.
- System-owned aborts no longer set the user-only queued-continuation suppression
  latch; a user join still sets it before awaiting the shared abort.

### Why

- TTSR can begin a corrective system abort immediately before the user presses
  Escape. The old early-return path kept `"system"` provenance and invoked the
  underlying abort twice, so Goal could ignore the user's durable stop intent.

### Why this cannot be expressed externally

- Abort provenance, shared-promise ownership, and queued-continuation suppression
  are private `AgentSession` lifecycle state.

### Expected merge conflict zones

- `core/agent-abort-provenance.ts`, `core/agent-settled-delivery.ts`, and
  `core/agent-session.ts` around `_emitExtensionEvent`, `_emitAgentSettled`,
  `abort`, and `_abortActiveAgentAndRetry`.

## Required-recovery admission supersession and bounded fallback sizing (2026-08-03)

### What changed

- An accepted required-compaction recovery now clears the stored admission rejection when its queued
  continuation is scheduled, so the originating `prompt()` resolves after the queued steer/follow-up
  completes instead of throwing the superseded `RequiredCompactionError`.
- Deterministic recovery sizing no longer materializes `JSON.stringify` for every retained message
  without a bound: the estimator fails closed on accessor-bearing, non-plain, cyclic, or callable
  values and exits early once the remaining `contextWindow - reserveTokens` budget is exceeded.
- Regression coverage pins the turn-end soft-cap reset across degradation-recovery early returns,
  accepted-recovery queued-steer supersession, accessor-safe fallback rejection, and the three-call
  continuation flow (previously ending in an unasserted faux queue-exhaustion error).

### Why

- Review of #679 reproduced a contradiction: queued continuation completed and both queues drained,
  yet the originating prompt still rejected with the stale required-compaction error.
- The same review measured ~207 MiB peak amplification from a 32 MiB retained message and observed
  property getters executing on persisted tool-call arguments during recovery sizing.

### Why this cannot be expressed externally

- Supersession lives in `AgentSession`'s internal compaction admission/continuation ownership; the
  sizing guard is a fail-closed property of the builtin deterministic-fallback estimator.

### Expected merge conflict zones

- `core/agent-session.ts` retry/continuation scheduling around `_checkCompaction` and `agent_end`.
- `core/extensions/builtin/compaction/deterministic-fallback.ts` estimator and projection call site.

## Keep long-running compaction recovery progressing (2026-08-03)

### What changed

- The automatic-compaction soft cap now resets after each provider turn instead of lasting for the
  whole multi-tool agent run. The completed turn's zero-yield recovery still observes its original cap
  before the reset, while the absolute session cap remains authoritative for every route.
- Required-compaction failures now resume queued work after an accepted recovery compaction without a
  synthetic `continue`, while rejected recovery remains terminal.
- Provenance-confirmed required recovery uses the persisted byte-derived estimate when no valid
  provider usage sample exists.
- Deterministic recovery measures the reconstructed suffix instead of stale cumulative assistant usage.
  It keeps the prepared boundary when safe and otherwise advances to the latest complete persisted user
  turn, including expanded skill text and its chronological suffix, with strict retained-message schemas.

### Why

- Long `ulw` runs could complete three valid compactions and then reject every later threshold
  compaction as if the whole agent run were one provider turn.
- When summarization then failed, a fitting skill-bearing suffix could be rejected because provider
  usage still described the discarded pre-compaction prefix. Repeated continuations surfaced the same
  threshold error instead of recovering.

### Why this cannot be expressed externally

- The fix depends on internal provider-turn lifecycle state, exact session entry boundaries, compaction
  admission, and continuation ownership.

### Expected merge conflict zones

- `src/core/agent-session.ts` compaction retry/continuation ownership and upstream telemetry lifecycle.
- `src/core/extensions/builtin/compaction/` admission, fallback, and provider-turn accounting.

## Compact completed apply_patch result details (2026-08-02)

### What changed

- Completed `apply_patch` previews retain the TUI's bounded diff and retain a complete unified patch only when it is at most 16 KiB per file; larger patch bodies are omitted rather than persisted or emitted as malformed truncated diffs.
- Nested applied-operation previews are rebuilt as lightweight metadata without full diff or patch bodies, including the fail-fast `ApplyPatchError` recovery result.
- App-server file-change projection keeps its complete unified-diff contract for retained patches within the 16 KiB budget; oversized patches do not produce a file-change diff from persisted result details.

### Why

- Full old/new file contents in unified patches dominated completed tool-result details after diff compaction, so large add, delete, and update operations still scaled with source size in session files and resident memory.
- App-server projection and session persistence consume the same completed result object with no extension-scoped post-projection persistence seam. A fixed budget is therefore required to bound retention without storing a second live-only copy; omitting oversized patches avoids sending invalid partial unified diffs.

### Why this cannot be expressed externally

- The payload and its source-backed unified patches are constructed inside the builtin `apply_patch` tool before app-server projection and session persistence.

### Expected merge conflict zones

- LOW: `core/extensions/builtin/gpt-apply-patch/apply.ts` and `tool.ts` completed-result construction.

## App-server extension RPC delivery (2026-08-12)

### What changed

- `modes/app-server/runtime.ts` subscribes to each bound session's opt-in extension RPC events before extension binding,
  preserves binding-time events until the thread is registered, and routes live events only to that thread's subscribers.
- `modes/app-server/rpc/registry.ts` registers `extension_request` and dispatches `{threadId,name,data}` to the loaded
  session's `extensionRunner.requestRpc`, preserving its exactly-one-handler semantics as JSON-RPC errors.
- `modes/app-server/threads/registry.ts` seeds a new thread's notification queue with binding-time extension records so
  the connection that started, resumed, or forked the thread receives them after subscription.

### Why

- App-server mode binds and owns separate sessions, so classic RPC's connection-bound extension delivery never reaches
  app-server clients in either direction.
- App-server initialize capabilities have no `extension_events` field. Event delivery is therefore unconditional for
  initialized subscribers, while thread subscriptions provide the required audience boundary.

### Why this cannot be expressed externally

- Both directions cross the app-server's internal thread/session registry and notification router. An extension can opt
  into delivery with `pi.rpc`, but cannot register an app-server JSON-RPC method or address the owning thread's clients.
- Ordinary `pi.events` channels remain extension-local; this change forwards only explicit `pi.rpc.emit` records at the
  connection boundary.

### Expected merge conflict zones

- MEDIUM: `modes/app-server/runtime.ts` session binding and registry wiring.
- LOW: `modes/app-server/rpc/registry.ts` method registration and `threads/registry.ts` initial notification storage.

## Backfill: injected app-server turns (2026-08-01)

### What changed

- App-server clients can inject turns through the runtime and thread handlers while preserving the normal turn lifecycle.

### Why

- Remote session controllers need a first-class path that behaves like an ordinary user turn.

### Why this cannot be expressed externally

- Injection crosses app-server runtime, thread state, turn scheduling, and session event emission.

### Expected merge conflict zones

- `modes/app-server/runtime.ts`, `threads/handlers.ts`, and `threads/turn-runtime.ts`.

## Supersede level-scoped high-reasoning warning deduplication (2026-07-31)

### What changed

- High-reasoning warnings are now deduplicated once per provider/model identity
  for the lifetime of an `AgentSession`, rather than once per
  provider/model/reasoning-level tuple.
- Moving between `xhigh`, `max`, lower reasoning levels, or another model and
  back does not append the same warning again.
- A different sensitive provider/model identity still receives its own first
  warning.

### Why

- The released provider/model/level behavior caused the large warning box to
  reappear while the user was only changing reasoning effort. This follow-up
  intentionally supersedes that earlier contract.

### Why extension system couldn't handle this

- Warning deduplication is session-owned state inside `AgentSession` and must
  apply consistently before TUI and RPC consumers receive the event.

### Expected merge conflict zones

- LOW: `core/agent-session.ts` high-reasoning warning state and emission.

## Required-compaction recovery and queue chronology (2026-07-31)

- Targeted required-compaction summarization failures can recover from a deterministic, suffix-safe local checkpoint without a second provider request; unfit recovery remains fail-closed and preserves the latest request.
- Truncation recovery requires structured transient `SummaryRequestError` provenance; generic error text cannot authorize fallback.
- Recovery retains task intent and UTF-8-safe bounded text while todo/checkpoint snapshots remain only in their separately persisted canonical entries, not duplicated in compaction details.
- Terminal queue restoration now follows global submission chronology across native and compaction-owned input through a non-enumerable compatibility side channel, without changing native steer priority or abort-state semantics.

## Refusal fallback exhaustion resets retry state (2026-07-31)

### What changed

- `core/agent-session.ts`: terminal classifier-refusal fallback exits now emit the matching failed `auto_retry_end` event and reset the retry attempt counter when a retry actually started.
- The zero-attempt refusal path remains event-free, so `auto_retry_end` still pairs only with a prior `auto_retry_start`.
- Regression coverage drives every configured fallback to refusal, then proves the session is idle and the interactive double-Escape history action works again.

### Why

- Refusal exhaustion previously resolved the retry promise without clearing `_retryAttempt`. The TUI therefore kept treating an idle session as retrying, so every Escape re-entered abort cleanup instead of arming the double-Escape session-history shortcut.

### Expected merge conflict zones

- LOW: `agent-session.ts` in `_handleRetryableError()`'s classifier-refusal terminal branches.

## Claude SDK OAuth provider identity (2026-07-31)

### What changed

- Renamed the SDK-backed Claude Pro/Max builtin provider, extension directory, runtime/model ID, OAuth storage sentinels, settings key, account directory, imports, tests, QA scenarios, and public commands from `claude-agent-sdk` to `claude-sdk-oauth`.
- Renamed the provider-local TypeScript symbols to the same identity while preserving the upstream npm dependency and executable packages under `@anthropic-ai/claude-agent-sdk`.
- Split the oversized stream test into prompt-bridge and stream-event suites without changing its five pinned behaviors.

### Why

- `claude-agent-sdk` conflated Senpi's provider identity with Anthropic's upstream package name and obscured that this lane is specifically the subscription OAuth surface.
- There was no separate `claude-oauth` implementation to retain; the renamed provider is the sole SDK-backed OAuth implementation.

### Why extension system couldn't handle this alone

- The extension owns the provider implementation, but host registration order, RPC/app-server account imports, persisted auth keys, settings, and QA surfaces all reference its identity outside the extension directory.

### Expected merge conflict zones

- HIGH: the renamed builtin extension directory and provider-focused tests.
- MEDIUM: builtin registration, RPC/app-server account imports, provider docs, and QA scenario names.

## Breaker-cancelled opportunistic compaction no longer blocks admission (2026-07-31)

### What changed

- `core/agent-session.ts`: prompt, final-payload, scheduled-continuation, and retry admission now proceed without opportunistic compaction when the latest compaction rejection is `circuit-breaker`.
- Final-payload admission still fails closed when the provider payload is actually oversized, and overflow-triggered compaction remains fail-closed.
- Regression and real-CLI coverage prove breaker cooldown does not permanently reject prompts while non-breaker cancellation remains blocking.

### Why

- The circuit breaker stops repeated summarization spend during provider outages. Converting its cooldown rejection into `RequiredCompactionError` permanently bricked sessions above the soft threshold instead of allowing the provider or existing overflow recovery to make the real admission decision.

### Why extension system couldn't handle this alone

- Extensions report the rejection cause, but core owns every provider-admission site and decides whether a failed opportunistic compaction blocks the turn.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` compaction admission and retry-continuation paths.

## Failed pre-prompt compaction reports terminal recovery (2026-07-30)

### What changed

- `core/agent-session.ts`: `_runPrePromptCompaction()` now emits failed `compaction_end` events with `willRetry: false`. Its caller throws `RequiredCompactionError` when compaction fails, so no retry can follow that terminal event.
- Coverage drives a real pre-prompt overflow compaction through a failing faux provider and pins both the truthful event and restoration of queued TUI input through the real interactive helper.

### Why

- Emitting `willRetry: true` deferred queued input to native session queues even though failed compaction blocks provider admission, leaving that input parked indefinitely.

### Why extension system couldn't handle this alone

- `willRetry` is authored inside the core pre-prompt compaction lifecycle before extensions consume the event; only the session can truthfully report whether its caller will retry.

### Expected merge conflict zones

- LOW: `agent-session.ts` in `_runPrePromptCompaction()`'s terminal catch emission.

## high_reasoning_warning narrowed to gpt-5.6-sol only (2026-07-30)

### What changed

- `high-reasoning-warning.ts`: `isSensitiveHighReasoningModel` now matches ONLY gpt-5.x "sol" variants via a dedicated regex (`/gpt-5(?:\.\d+)?-sol(?![a-z])/i`), fully decoupled from `supportsXhigh`/`supportsMax`. The prior implementation reused those capability gates, so the scary warning wrongly fired for every frontier model that merely supports xhigh/max (claude-fable-5, opus, sonnet-5, deepseek-v4).

### Why

- The warning is about a specific risky model family (gpt-5.6-sol-like), not about xhigh/max capability. Conflating the two surfaced the warning on anthropic/claude-fable-5 @ xhigh, which was not intended. The negative lookahead keeps unrelated ids such as `upstage/solar-pro-3` from matching.

### Why extension system couldn't handle this alone

- The detection is consumed by the in-session emit path (`agent-session.ts`); it is core risk logic, not an extension concern.

### Expected merge conflict zones

- LOW: `high-reasoning-warning.ts` `isSensitiveHighReasoningModel`. `thinking-levels.ts` is deliberately unchanged so capability gating (fable-5 still supports xhigh/max) is preserved.

## Kimi XTML thinking recovery runs without tools (2026-07-30)

- `ModelRuntime.stream()` and `streamSimple()` now compose model recovery through the AI package's shared
  `wrapStreamWithModelRecovery()` boundary.
- Kimi structural response-channel recovery therefore runs on final-answer requests with an empty tool list, while
  Claude/Kimi leaked tool-call recovery still activates only when tools are available.
- Real CLI QA adds `--scenario kimi-xtml-thinking-recover`, proving a malformed thinking-only first response is
  discarded, the second response is visible exactly once, XTML markers never leak, real auth is unchanged, and
  the sandbox is cleaned.

## Runtime API keys propagate to session titles (2026-07-30)

- Background session-title generation now reuses the active agent request API key before resolving provider
  headers and compatibility options.
- This prevents a turn launched with `--api-key` from succeeding under one credential and then sending its
  `x-apitopia-session` title request with a different configured credential, which Apitopia rejects with 401.
- Coverage: `test/agent-session-auto-title-routing.test.ts`.

## high_reasoning_warning for sensitive frontier models at xhigh/max (2026-07-30)

### What changed

- New `core/high-reasoning-warning.ts`: provider-agnostic, model-name-based detection (`isSensitiveHighReasoningModel`, reusing `supportsXhigh`/`supportsMax`) plus `shouldWarnHighReasoning` and `buildHighReasoningWarning`.
- `agent-session.ts`: emits a new `high_reasoning_warning` `AgentSessionEvent` when a sensitive model is driven at xhigh/max, deduped by provider/model/level, wired into `_switchActiveModel` and `_setThinkingLevel`.

### Why

- Frontier reasoning models (gpt-5.x, deepseek-v4-pro/flash, opus-4-6..5, sonnet-5, fable-5) at xhigh/max are acutely prompt-sensitive: human-prompted runs risk non-stopping, unrequested actions, or risky behavior. The warning urges use via the ultrabrain subagent and states direct-use responsibility.

### Why extension system couldn't handle this alone

- The event must fire from session model/thinking-level transitions inside `AgentSession`, which extensions can only observe after the fact; the dedupe + emit belongs in the session lifecycle.

### Expected merge conflict zones

- LOW: `agent-session.ts` `_switchActiveModel`/`_setThinkingLevel` and the `AgentSessionEvent` union.

## Ollama Cloud keeps its provider-owned dynamic catalog (2026-07-30)

### What changed

- `ModelRuntime` leaves builtins that already implement `refreshModels` unwrapped instead of replacing their
  refresh path with the static `pi.dev` catalog overlay. This preserves both Radius and the new Ollama Cloud
  `/api/tags` + `/api/show` discovery path.
- An `ollama` provider with an explicit models.json catalog does not run the Cloud builtin refresh first and replaces
  rather than augments any in-memory Cloud catalog. Hot reload therefore removes stale Cloud tags instead of rebinding
  them to the local base URL, without affecting dynamic discovery for Radius or other providers.
- The CLI recognizes `ollama` as `Ollama Cloud`, documents `OLLAMA_API_KEY`, and uses
  `qwen3.5:397b` as the current default when it is present in the refreshed catalog.
- `test/ollama-provider.test.ts` drives `ModelRuntime.create()` with a mocked Ollama host and proves the
  provider-owned catalog reaches the runtime and persisted model store.

### Why this belongs in core

- Builtin catalog wrapping happens before extensions and models.json overlays are composed. A provider factory
  cannot preserve its own refresh implementation after the runtime has replaced it.

### Expected merge conflict zones

- LOW: builtin wrapping predicates in the async and sync `ModelRuntime` constructors.
- LOW: additive provider display/default/help entries.

## Bun self-updates preserve the Bun launcher (2026-07-30)

- Bun-managed global self-updates now replace Bun's generated Node-shebang symlink with a small launcher that
  executes the updated `dist/cli.js` through the Bun runtime that performed the repair.
- The repair uses the Bun runtime's own `process.execPath`, supports Bun binaries installed outside the global bin
  directory, and is skipped on Windows where Bun uses platform-specific shims.
- If `bun pm bin -g` does not return a global bin directory, self-update is now rejected instead of installing
  without a launcher repair.
- Coverage: `test/suite/regressions/496-bun-launcher-self-update.test.ts`.

## Shell-command credential resolution retries before giving up (2026-07-29)

### What changed

- `core/resolve-config-value.ts`: `executeCommandUncached` now runs up to 3 attempts (250ms then 1000ms backoff
  via a blocking `Atomics.wait` sleep — the call sites are synchronous `execSync`/`spawnSync` already) before
  returning `undefined`. Previously a single failed spawn, non-zero exit, or timeout of a credential helper
  propagated through `resolveConfigValueOrThrow` as `Failed to resolve API key … from shell command`, which
  `agent-session` classifies as hard-error eligible and ejects the active model without a single retry.
- Coverage: `test/resolve-config-value.test.ts` — new: transient-fail-then-success resolves on attempt 3;
  persistent failure bounded at exactly 3 attempts. Updated: cache-failure arithmetic (one failing resolve now
  costs 3 executions before the `undefined` is cached).

### Why

- Incident session `019faccb-3e7c-7307-8b19-2c7fb9e77b5c` (2026-07-29), five fallback cascades in one day:
  every cascade opened with `API key auth failed for provider kimi-code: Failed to resolve API key … from shell
  command: omp token kimi-code`, hard-error ejecting `kimi-code/k3`; the same flake hit `omp token anthropic`
  mid-chain. Measured `omp token` cold-start latency is 1.5–4.0s per invocation (bun startup + SQLite auth
  store); under load the subprocess intermittently fails while the credential itself is healthy — re-running it
  seconds later succeeds. A hard-error ejection on a transient resolver blip converts a one-second hiccup into
  a full provider-switch cascade (primary → exhausted fallbacks → last-resort model).

### Expected merge conflict zones on next upstream sync

- MEDIUM: `core/resolve-config-value.ts` also exists upstream in badlogic/pi-mono (same
  `executeCommandUncached`), so the retry wrapper (`executeCommandOnce` keeps the original body) can collide
  with upstream edits to that function; constants and `sleepBlocking` are additive. The same fix belongs
  upstream as well.

## Kimi XTML recovery preserves protocol identity (2026-07-29)

### What changed

- `core/model-runtime.ts` passes both `createXtmlRecoveryStreamParser` and `protocol: "kimi-xtml"` to the shared
  invoke-recovery wrapper for Kimi models.
- Successful recovered tool calls and terminal recovery failures now expose Kimi-specific diagnostics and
  `recovered-kimi-xtml-*` IDs instead of misleading ANTML metadata.
- `test/kimi-xtml-recovery-runtime-boundary.test.ts` pins the user-visible runtime result while the default ANTML
  path remains covered in the AI package.

### Expected merge conflict zones

- LOW: the two invoke-recovery call sites in `core/model-runtime.ts`.

## Static credential headers participate in real provider auth resolution (2026-07-29)

### What changed

- `core/provider-header-auth.ts` classifies only credential-like provider headers, preserves case-insensitive
  override semantics, and derives distinct models.json versus extension status sources.
- `core/provider-api-key-auth.ts` resolves credential-bearing provider headers into a genuine header-only
  `AuthResult`, exposes the same result through `checkAuth()`, and leaves metadata-only or empty header maps
  unconfigured. Header-only auth does not fabricate an API-key login method, and OAuth providers remain logged out
  when their only configured headers are request metadata.
- `configuredRequestAuthStatus()` uses the same credential-header contract, keeping synchronous registry reads,
  asynchronous availability snapshots, TUI/RPC status, and request execution aligned.

### Why this belongs in core

- Auth resolution, registry availability, and status projection are package-owned provider-composition seams. An
  extension can supply headers but cannot make the shared model runtime interpret them consistently.

### Coverage

- `test/provider-composer-headers-auth.test.ts` exercises models.json and extension header auth through registry
  availability, `checkAuth()`, `getAuth()`, and runtime streaming, while locking metadata, empty-header, OAuth, API
  key, and `authHeader` behavior.
- `packages/ai/test/auth-headers.test.ts` and `packages/ai/test/openai-header-auth.test.ts` cover the shared
  classification and OpenAI-compatible request path.

### Expected merge conflict zones

- LOW: additive `core/provider-header-auth.ts`, `core/provider-api-key-auth.ts`, and focused regression coverage.
- MEDIUM: `core/provider-composer.ts` auth composition and status projection.

## Provider-agnostic default fallback chain via bare model-id families (2026-08-09)

### What changed

- `core/retry-fallback/expansion.ts` (new): conservative model-family matching (`id === bare ||
  id.startsWith(bare + "-")` after stripping a `.`/`/` namespace, never a substring `includes`), per-provider
  variant selection (exact id > shortest > alphabetical), and provider ranking for bare selectors: providers
  holding an OAuth credential first, then the fixed table `[claude-sdk-oauth, anthropic, kimi-coding]`, then
  alphabetical. `openrouter` / `openrouter-images` are excluded from bare expansion.
- `core/retry-fallback/settings.ts`: the shipped default is now declared with bare model ids -
  `{"claude-fable-5": ["k3:max", "claude-opus-5:xhigh", "claude-opus-4-8:xhigh"]}`. The previous literal
  `anthropic/claude-fable-5 -> apitopia/kimi-k3-unlocked:max, ...` is gone, including the `apitopia` gateway id.
  An empty entry list is no longer deleted at resolve time; it is preserved as a tombstone.
- `core/retry-fallback/chains.ts`: `canonicalizeFallbackChains` expands bare keys into one canonical
  `<provider>/<id>` key per serving provider and bare entries into a ranked, model-major candidate list.
  Explicit provider-qualified keys are applied after expansion so they override it, and tombstones are honored
  at both bare-family and canonical-provider granularity.
- `core/retry-fallback/controller.ts`: the registry dep accepts an optional `isUsingOAuth(model)` so runtime
  candidate selection ranks the same way the `/fallback` display does.
- `core/retry-fallback/validate.ts`: a bare key naming a registered family is valid configuration; a bare key
  matching nothing keeps the original "roles are unsupported" guidance.
- Bare candidates fan out to at most `MAX_PROVIDERS_PER_FAMILY` (2) providers, ranked by auth tier
  (OAuth credential, then any configured credential, then the rest). Auth ranks candidates and never filters
  them: the runtime already skips unauthenticated candidates, and filtering during canonicalization erased the
  chain whenever an availability snapshot was not populated yet.
- `core/extensions/builtin/model-fallback/settings.ts`: `/fallback` renders chains canonicalized against
  `modelRegistry.getAvailable()` so the menu lists only models the user can select, while the runtime keeps
  resolving against the full registry.

### Why

- The default chain was keyed on the literal provider id `anthropic`. Fable 5 attached through any other
  provider - the builtin `claude-sdk-oauth` extension (which mirrors the whole Anthropic catalog via
  `getModels("anthropic")`), a gateway, or Bedrock's namespaced ids - never matched the key, so
  `canonicalizeFallbackChains` dropped the chain, `hasConfiguredChain()` went false, and the default
  `abortServerSideFallback: true` left the session with provider-side fallback blocked and no client chain:
  the exact dead end the 2026-07-29 default was introduced to remove.
- Ranking by auth tier also fixes same-account thrash: when both `claude-sdk-oauth` and `anthropic` serve
  `claude-opus-5`, both now appear as candidates, so a dead account is skipped by cooldown and the live one
  is used instead of exhausting the chain inside one account.
- `apitopia/kimi-k3-unlocked` is a personal gateway id that should never have shipped as a product default.

### QA

- Real-CLI QA (senpi-qa Channel 2, TUI in a pty, isolated sandbox, `PI_OFFLINE=1`): with Fable 5 served only by
  `claude-sdk-oauth` and no `retry.fallbackChains` configured, `/fallback` renders
  `claude-sdk-oauth/claude-fable-5 -> kimi-coding/k3:max, claude-sdk-oauth/claude-opus-5:xhigh,
  claude-sdk-oauth/claude-opus-4-8:xhigh` where the previous default produced no chain at all. That QA run is
  what surfaced both the fan-out cap and the display scoping above; neither was visible to unit fixtures.

### Expected merge conflict zones on next upstream sync

- LOW: `core/retry-fallback/expansion.ts` is additive and fork-local with no upstream counterpart.
- LOW: the default chain literal in `core/retry-fallback/settings.ts`.
- MEDIUM: `canonicalizeFallbackChains` in `core/retry-fallback/chains.ts` was restructured (two passes plus
  tombstones) rather than edited in place.
- LOW: the optional `isUsingOAuth` member on the controller registry dep.
- LOW: the display-scoping helper in `core/extensions/builtin/model-fallback/settings.ts`.

## Anthropic credits_required 429 pins the billing fallback (2026-07-29)

### What changed

- `core/retry-fallback/billing.ts`: `BILLING_ERROR_PATTERN` now matches Anthropic Console credit exhaustion —
  the 429 `rate_limit_error` whose details carry `error_code: credits_required` ("Usage credits are required
  for this model."). The hard-error fallback branch classifies the shape as `billing` instead of `hard-error`.
- `core/retry-fallback/cooldown.ts`: the 30-minute billing suppression bucket covers the same wording instead
  of the 30-second rate-limit bucket that let cooldown-expiry resurrect the dead model.
- Coverage: `test/suite/retry-fallback-billing-swap.test.ts` (pinned swap + classifier rows),
  `test/suite/retry-fallback-cooldown.test.ts` (duration rows); channel-3 real-CLI proof
  `.agents/skills/senpi-qa/scripts/mock-loop-credits-fallback.mjs` (one primary request, `reason: "billing"`
  in fallback.log, final marker streamed by the fallback model).

### Why

- Incident session `019fac55-3531-7d35-92f1-2d740b659c3c` (2026-07-29): `anthropic/claude-fable-5` answered
  429 credits_required. The switch to `apitopia/kimi-k3-unlocked` fired as `transient`, the 30-second cooldown
  expired, and cooldown-expiry reverted the session into the billing-dead fable-5; the chain then thrashed
  fable-5 → kimi-k3 → opus-5 → opus-4-8 → fable-5 until the session was abandoned. Billing-class failures
  never recover on the same account, so the fallback for one must pin from the first failure.

### Expected merge conflict zones on next upstream sync

- LOW: one regex each in `core/retry-fallback/billing.ts` and `core/retry-fallback/cooldown.ts`; both modules
  are fork-local.

## From-source real-config warning (2026-07-29)

### What changed

- New `from-source-config-guard.ts`: pure predicates detecting a run from TypeScript sources (module URL extension, never a bun binary) whose resolved agent dir is the real `~/.senpi/agent` with no `SENPI_CODING_AGENT_DIR` override.
- `main.ts` prints one yellow stderr warning right after agent-dir resolution when that combination holds, advising an isolated agent dir for dev/QA runs. No change to `resolveAgentDir` precedence or any default.

### Why

- Ad-hoc from-source runs inside the repo (which has `.senpi/` without `agent/`) silently target the real user config; that exact setup has previously leaked writes into the user's `settings.json`. Detection is separated from policy: the warning makes the footgun visible without breaking legitimate real-config runs.

## Interactive startup loading indicator (2026-07-29)

### What changed

- New `cli/startup-loading-indicator.ts`: single-line dim ANSI spinner (`⠋ Loading senpi… <phase>`) with a
  120ms grace delay (fast startups stay flash-free), phase updates, pause/resume, and an idempotent `stop()`
  that clears the line and restores the cursor (also via a `process` exit hook). It engages only when
  `appMode === "interactive"`, stdout is a TTY, and `--help` was not requested.
- `main.ts` starts the indicator before `createAgentSessionRuntime` — the extensions/models/trust window that
  previously rendered nothing — switches the phase to `opening session` before the initial session is created,
  and stops it in a `.finally` before any other stdout writer (TUI, help, diagnostics) takes over.
- Mid-load project-trust prompts (`createProjectTrustContext` `ui.select`/`confirm`/`input`) are wrapped by
  `pauseIndicatorDuringPrompts`, so the trust selector TUI never fights the spinner for the terminal.
- Coverage: `test/startup-loading-indicator.test.ts` (grace delay, frame animation, phase updates,
  pause/resume, stop idempotency, TTY/help gating, prompt-pause wrapping).

### Why

- Interactive startup completed the entire heavy runtime creation before the TUI existed, leaving the terminal
  blank and apparently stuck (QA repro: ~23s of empty screen with a slow-loading extension). Codex's TUI
  addresses the same window by rendering a dim placeholder header until the session is configured
  (`codex-rs/tui` chatwidget); this is the minimal-conflict equivalent for senpi's pre-TUI bootstrap window.

### Expected merge conflict zones on next upstream sync

- LOW: the import block and indicator wiring around `createAgentSessionRuntime` in `main.ts`; the module itself
  has no upstream counterpart.
- LOW: the `projectTrustContext` fallback wrap inside `createRuntime`.

## Repeated provider-stream stalls escalate to the fallback chain (2026-07-29)

### What changed

- `core/agent-session.ts`: the transient retry branch tracks consecutive provider-stream stalls
  (`isProviderStreamStallError` from pi-ai, covering both the idle-timeout and stream-start-timeout wordings). The second consecutive stall escalates to the fallback chain
  immediately (same `tryFallback("transient")` path as budget exhaustion); without a chain the retry loop ends
  instead of replaying the identical payload for the remaining same-model budget. Non-stall failures reset the
  streak, fallback switches and fresh retry loops start at zero.
- Coverage: `test/suite/retry-fallback-stall-escalation.test.ts` (escalation with chain, surrender without chain,
  streak reset for non-consecutive stalls).

### Why

- A stall means the provider accepted the request and delivered zero events for the entire idle budget
  (`httpIdleTimeoutMs`, default 300s). Each retry replays an identical payload, so a hung provider/gateway
  previously cost (1 + maxRetries) * 300s (~20 minutes) of opaque dead air per turn before the chain was
  consulted - experienced as a permanently wedged session (Discord report 2026-07-29, donated session
  019fa8da-43ad-70b7-b01b-8f34f4d907f2 records 1906/1919: reopening a 5h session hit the 300s idle timeout on
  every goal-continuation while new sessions worked).

### Expected merge conflict zones on next upstream sync

- MEDIUM: `_handleRetryableError` transient branch and the `switchedFallback` reset in `core/agent-session.ts`.

## Availability-aware default Fable fallback chain (2026-07-29)

### What changed

- `core/retry-fallback/settings.ts` now owns retry setting types and normalization, including the shipped default
  `anthropic/claude-fable-5` chain:
  `apitopia/kimi-k3-unlocked:max` -> `anthropic/claude-opus-5:xhigh` ->
  `anthropic/claude-opus-4-8:xhigh`.
- The default applies only when `retry.fallbackChains` is absent or malformed. Explicit chain maps, including
  an explicitly empty map, remain authoritative.
- `core/retry-fallback/chains.ts` and the model-fallback builtin omit unavailable models and remove chains with
  no usable candidates, so runtime selection and `/fallback` display agree.
- Existing defaults remain enabled: model fallback on, server-side fallback abort on, and cooldown-expiry revert.
- Coverage: `test/settings-manager-retry-fallback.test.ts`,
  `test/suite/model-fallback-command.test.ts`, and `test/suite/model-fallback-host-wiring.test.ts`.

### Why

- A fresh Senpi install previously aborted provider-side fallback by default but had no client chain, producing a
  dead-end warning. Shipping the preferred chain makes that default policy actionable while keeping optional model
  providers safe: missing models are skipped rather than warned about or selected.

### Expected merge conflict zones on next upstream sync

- LOW: retry settings imports and delegation in `core/settings-manager.ts`; the new retry settings module has no
  upstream counterpart.
- LOW: canonical chain construction in `core/retry-fallback/chains.ts`.
- LOW: registry-aware loading in `core/extensions/builtin/model-fallback/`.

## Stream-start timeout wiring and unregistered-api error context (2026-07-29)

### What changed

- `core/settings-manager.ts`: new `retry.provider.streamStartTimeoutMs` setting and
  `getAgentStreamStartTimeoutMs()` (default 90000ms; 0 disables; the default is clamped to a
  shorter idle timeout and disabled together with a disabled idle guard). `core/sdk.ts` and the
  interactive settings handler wire it into `Agent.streamStartTimeoutMs`.
- `core/provider-composer.ts`: the stream-time `No API provider registered for api: <api>` error
  now names the model (`provider/id`) and points at the models.json provider entry or the missing
  provider extension.
- Coverage: `test/settings-manager.test.ts` (retry describe), `test/provider-composer-unknown-api.test.ts`,
  `packages/ai/test/retry.test.ts` (stream timeout wordings stay retryable).

### Why

- Incident (donated session log): a dead upstream accepted requests but never sent a first byte.
  With only the 300s idle bound, each turn attempt froze the session for 5 minutes with `usage: 0`
  and nothing persisted; retries repeated the same 300s wait, making the session practically
  unrecoverable while new sessions worked. A 90s first-event bound with the retryable wording lets
  the retry/fallback ladder engage quickly. Related incident error `No API provider registered for
  api: kiro-api` carried no context about which model or config produced it.

### Expected merge conflict zones on next upstream sync

- LOW: one settings getter + one field in `ProviderRetrySettings`; one error message in
  `composeModelProvider`; one option in the `Agent` construction in `core/sdk.ts`.

## Provider idle retries preserve user input and use a bounded retry budget (2026-07-29)

### What changed

- `core/agent-session.ts`: retries triggered by the shared anchored provider-timeout classifier defer queued steering
  and follow-up input from the retry's first provider request. This covers the two agent-loop stream watchdog messages
  and exact transport-level `Request timed out` variants without matching incidental command, MCP, or extension text.
- `core/settings-manager.ts`: `retry.provider.streamRetryTimeoutMs` configures the first-request retry liveness cap
  (default 30 seconds; `0` disables). The retry clamps only enabled idle/start guards, so it never re-enables an
  explicitly disabled guard. Both timeout bounds return to their configured values for later provider requests.
- The retry start bound is capped as well as the provider request option, while the configured idle timeout resumes
  after the first event so healthy reasoning gaps are not limited to 30 seconds.
- Consecutive transport timeouts reported with `stopReason: "aborted"` keep consuming the same retry counter. Only a
  genuinely successful assistant response resets the budget or emits `auto_retry_end { success: true }`.
- Retry continuations use the session-work barrier and revalidate atomically with the scheduled-continuation path.
  Accepted recompaction stays queue-first while retaining timeout options; reconstructed failed assistant tails are
  retired before continuation. A concurrent low-level `Agent.prompt()` is treated as a benign takeover, and session
  settlement is never emitted while Agent core is still streaming.
- Coverage: `test/suite/regressions/provider-idle-recovery.test.ts` pins exact request text/order, configurable timeout
  sequences, disabled guards, negative classifier shapes, and a real no-first-event stream expiry at the cap;
  `test/settings-manager.test.ts` pins setting defaults and `0` semantics.

### Why

- A silent provider stream previously consumed user steering into another full-length retry. Repeated 300-second
  retries made the session look stuck and could leave the user's `continue` adjacent to an error instead of a real
  answer.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `core/agent-session.ts` retry-controller continuation options and scheduled-continuation admission.
- LOW: `core/settings-manager.ts` provider retry settings and timeout getters.

## Absent fallback chains no longer produce a startup warning (2026-07-28)

### What changed

- `core/retry-fallback/validate.ts`: `validateFallbackChains(undefined, registry)` now returns no warnings. Explicit malformed values such as `null` and arrays still produce `Fallback chains must be a plain object.`
- Coverage: `test/suite/retry-fallback-validate.test.ts` pins the absent-setting case.

### Why

- `retry.fallbackChains` is optional. A fresh configuration without the setting previously emitted a misleading startup warning even though the user had not configured a malformed chain.

### Expected merge conflict zones on next upstream sync

- LOW: one early return in `validateFallbackChains`.

## Footer shows (OmO Native) when the local omo-senpi + senpi-task stack is installed (2026-07-28)

### What changed

- `core/omo-native-detect.ts` (new): `detectOmoNativeInstall(packages, agentDir)` — sync, dependency-free detection of the "OMO Native" local install. A settings `packages` entry that is a local path resolving to a dir whose package.json name is `@code-yeongyu/omo-senpi`, whose derived repo root (`pluginPath/../../..`) contains both workspace packages `@oh-my-opencode/omo-senpi` and `@oh-my-opencode/senpi-task`. Mirrors gates 1 and 2 of the beta `detectOmoLocalInstall` (beta/omo-local-update.ts), dropping gate 3 (the `git rev-parse --show-toplevel` integrity check) so it stays sync and cheap for footer rendering; the beta module's export policy forbids importing its helpers into production core.
- `core/footer-data-provider.ts`: `FooterDataProvider` gains `setOmoNative(boolean)` / `isOmoNative()` (field-backed, matching the existing `availableProviderCount` injection pattern) and `isOmoNative` is exposed on `ReadonlyFooterDataProvider`.
- `modes/interactive/interactive-mode.ts`: after constructing the provider, calls `setOmoNative(detectOmoNativeInstall(this.settingsManager.getPackages(), getAgentDir()))`.
- Coverage: `test/omo-native-detect.test.ts` pins happy + edge cases; `test/omo-native-footer.test.ts` pins the rendered segment; `test/footer-width.test.ts`, `test/grok/footer.test.ts`, `test/grok/classic-chrome-characterization.test.ts` updated for the new `isOmoNative` Pick member.

### Why

- A senpi session backed by the local OMO source checkout (omo-senpi + senpi-task workspace packages installed as a local-path package) is the "OMO Native" configuration; surfacing it in the footer makes the active stack visible at a glance, mirroring the detection already used by the beta `senpi update` local-update flow.

### Expected merge conflict zones on next upstream sync

- LOW: `core/footer-data-provider.ts` around the `availableProviderCount` field and the `ReadonlyFooterDataProvider` Pick (additive).
- LOW: `modes/interactive/interactive-mode.ts` around the `FooterDataProvider` construction site.
- NEW file `core/omo-native-detect.ts` — no upstream counterpart, no conflict.

## Provider-qualified fallback selectors resolve inside their own provider (2026-07-28)

### What changed

- `core/retry-fallback/chains.ts`: `parseFallbackSelector` now filters the lookup list to the explicitly requested provider before calling `parseModelPattern`. Previously the id pattern was resolved globally, so a foreign id containing the pattern won over the requested provider's exact id: `anthropic/claude-opus-5:xhigh` fuzzy-matched Bedrock's `us.anthropic.claude-opus-5`, failed the provider check, and produced the spurious startup warning `Fallback chain entry ... is not a valid or known model selector.` (The ambiguity arises whenever two configured providers carry the same bare id, e.g. `anthropic` + `anthropic-api`, which makes the bare-id exact match ambiguous and drops resolution into partial matching.)
- Coverage: `test/suite/retry-fallback-chains.test.ts` pins in-provider resolution when `anthropic`, `anthropic-api`, and `amazon-bedrock` all carry colliding `claude-opus-5` ids, with and without a thinking-level suffix.

### Why

- A selector with an explicit provider can only ever resolve inside that provider (the post-check rejected cross-provider results), so global resolution could only turn valid selectors into spurious warnings; scoping converts those failures into the correct in-provider match.

### Expected merge conflict zones on next upstream sync

- LOW: one scoped-lookup block inside `parseFallbackSelector` in `chains.ts`; upstream edits to selector parsing will conflict trivially.


## Paste markers survive editor hand-off and setText round-trips (2026-07-28)

- `modes/interactive/interactive-mode.ts` `setCustomEditorComponent()` now transfers editor content safely when switching between the default and a custom editor: if both editors support the paste-state API (`getPasteState`/`setPasteState` from pi-tui), the raw text plus the registry snapshot are transferred so `[paste #N ...]` markers stay collapsed; otherwise it falls back to the expanded text — `getExpandedText?.()`, or expansion from the paste snapshot via the exported `expandPasteMarkers()` when the source implements `getPasteState` without `getExpandedText`, or the raw text when neither capability exists. Previously the raw text alone was copied into a fresh editor with no registry, turning live markers into dead literals and silently dropping the pasted body from the submitted prompt.
- The companion tui change (`packages/tui/src/changes.md`, same date) makes `Editor.setText()` prune (exact canonical-marker match) instead of clear the paste registry, which fixes the remaining same-instance round-trips: `showExtensionCustom()` save/restore and `restoreQueuedMessagesToEditor()` / `abortAndFireQueuedMessages()` draft restoration. Those call sites are unchanged.
- Symptom fixed: transcript/session showed only the `[paste #1 +18 lines]` placeholder as the user message after pasting, opening a dialog (or aborting with queued messages), and submitting.
- `setCustomEditorComponent(undefined)` is now a draft no-op when the default editor is already active (e.g. `resetExtensionUI()` calls it unconditionally during extension resets): no hand-off happens, so no setText round-trip touches the user's draft.
- Details for the interactive hand-off live in `src/modes/interactive/changes.md` (same date).
- Coverage: `test/suite/regressions/0000-editor-paste-marker-transfer.test.ts` drives the real `setCustomEditorComponent` (prototype + fakeThis pattern) with real tui editors: registry transfer to a paste-aware editor, expanded-text fallback for a plain `EditorComponent`, restore to the default editor, full plain-editor round-trip, and the same-instance no-op.

## Prompt-cache-aware foreground tool budgets (2026-07-28)

### What changed

- `core/settings-manager.ts`: new `PromptCacheSettings` (`cacheAwareTimeouts?: boolean` default true,
  `safetyBufferSeconds?: number` default 30) exposed as `Settings.promptCache`.
- `core/prompt-cache-budget.ts` (new): `resolvePromptCacheSafeWaitSeconds(model, settings, env)` =
  pi-ai's resolved cache TTL minus the safety buffer, or `undefined` when the feature is disabled, no model
  is active, the TTL is unknown, or the buffer swallows the whole TTL. Also exports
  `PROMPT_CACHE_SAFE_WAIT_ENV` and `DEFAULT_PROMPT_CACHE_SAFETY_BUFFER_SECONDS`.
- `core/agent-session.ts`: `resolvePromptCacheSafeWaitSeconds()` recomputes from the LIVE current model, and
  `syncPromptCacheSafeWaitEnv()` mirrors it into the advisory `PI_PROMPT_CACHE_SAFE_WAIT_SECONDS` env var
  (deleted when no budget applies) on session start, reload, and every model select — so out-of-process
  readers such as the omo `task` tool can size their own foreground waits.
- The typed `ExtensionContext.getPromptCacheSafeWaitSeconds()` getter is documented in
  `core/extensions/changes.md`.

### Why

- Blocking a foreground tool past the model's prompt-cache lifetime expires the cache and forces a full
  re-read on the next request. Sizing the ceiling by the cache TTL keeps the cache warm, and the still-running
  work is handed to a background session alive instead of being killed.

### Behavior when no budget applies

- Byte-identical to previous behavior: the injected bash default and recommended maximum keep their existing
  values, the policy prompt is unchanged under strict string equality, and the env var is absent.

## Catalog `-fast` variants resolve serviceTier/upstreamModelId without models.json entries (2026-07-28)

### What changed

- `core/provider-composer.ts` `resolveCompatibilityRequestConfig()`: `upstreamModelId` and
  `serviceTier` now fall back to the catalog `Model`'s own optional fields
  (`extensionModel ?? modelDefinition ?? model`), so generated catalog variants such as
  `openai/gpt-5.5-fast` (upstreamModelId `gpt-5.5`, serviceTier `priority`) request the priority
  tier and the upstream wire id with zero models.json configuration. Config and extension model
  definitions keep precedence over catalog defaults.
- Coverage: `test/model-runtime-catalog-service-tier.test.ts` pins the catalog fallback, the
  models.json override path, and end-to-end resolution through `ModelRuntime` (offline).

### Why

- `-fast` pseudo-models previously worked only when hand-declared in models.json; the generated
  OpenAI priority-tier variants (pi-ai `Model.upstreamModelId`/`serviceTier`) were inert without
  this fallback, since the main request path reads both values exclusively through
  `resolveCompatibilityRequestConfig()`.

### Expected merge conflict zones on next upstream sync

- LOW: two-line `??` fallback change in `resolveCompatibilityRequestConfig()`.

## Cancellable `session_before_reload` veto blocks reload while extensions protect live work (2026-07-28)
## Nearest-parent configuration discovery (2026-07-28)

### What changed

- `config.ts`: `getAgentDir()` now honors `SENPI_CODING_AGENT_DIR` first, otherwise finds the nearest ancestor with a real `.senpi/agent` directory before falling back to `~/.senpi/agent`. The exported `resolveAgentDir(cwd, homeDir, envDir)` makes the precedence contract deterministic for callers and tests.
- `nearest-parent-config.ts`: centralizes the bounded upward walk for config directories. It excludes `$HOME` so global configuration remains the fallback layer and refuses symlinked `.senpi` directories.

### Why

- Starting senpi from a nested project directory previously ignored that project's config and always selected the home agent directory.

### Expected merge conflict zones on next upstream sync

- LOW: `config.ts` around `getAgentDir()`; the discovery helper is a focused fork-owned module.


### What changed

- New cancellable extension event `session_before_reload` (`core/extensions/types.ts`, routed through the
  existing session-before machinery in `core/extensions/runner.ts`). `AgentSession.reload()`
  (`core/agent-session.ts`) now returns `{ cancelled: boolean; reason?: string }` and consults the new
  `checkReloadVeto()` BEFORE emitting `session_shutdown`, so a cancelling extension prevents the entire
  teardown on every reload path (`/reload`, `ctx.reload()`, config hot-reload, direct SDK/rpc/print calls).
- Interactive `/reload` pre-checks the veto and surfaces the extension's `reason` as a warning
  (`modes/interactive/interactive-mode.ts`). Docs: `docs/extensions.md` event flow + `#session_before_reload`.
- Coverage: `test/suite/session-before-reload.test.ts` pins veto-aborts-before-shutdown, normal reload
  passthrough, and the side-effect-free `checkReloadVeto()` probe.

### Why

- A reload tears down the extension runtime; extensions running background subagents (omo-senpi task
  runtime) had their children killed mid-flight by `/reload` or a config hot-reload. Only the session owns
  the teardown ordering, so the veto checkpoint must live in core, mirroring `session_before_switch`.

### Expected merge conflict zones on next upstream sync

- LOW: additive event plumbing in `extensions/types.ts` / `extensions/runner.ts`; MEDIUM: head of
  `reload()` in `agent-session.ts` (early-return veto + return-type change).

## Multi-session RPC host initializes the theme before serving sessions (2026-07-28)

### What changed

- `main.ts`: the `--mode rpc --multi-session` branch now calls `initTheme(startupSettingsManager.getTheme(), false)` immediately before `runMultiSessionHost(...)`. The host returns `Promise<never>`, so the pre-existing `initTheme()` call further down `main()` is unreachable on this path and the theme proxy stayed uninitialized for the whole host lifetime.
- Regression: `test/suite/regressions/0000-multi-session-theme-init.test.ts` spawns the real CLI in multi-session mode with a global extension that touches `theme` at load time and opens a session; pre-fix the extension load crashes with "Theme not initialized. Call initTheme() first." (surfaced by embedders such as T3 Code as transcript errors), post-fix the probe loads and the transcript stays clean.

### Why

- Extensions load per `open_session` inside the multi-session host, and any extension (or render helper) that reads the `theme` proxy crashed the session with "Theme not initialized". An extension cannot fix this ordering itself: the theme must be initialized by the host bootstrap before extension code runs, so this is a core `main.ts` fix.

### Expected merge conflict zones on next upstream sync

- LOW: one additive call (plus comment) inside the multi-session dispatch branch in `main.ts`; upstream edits to that branch will conflict trivially.

## Experimental `--grok-neo` mode: env-gated grok chrome for the interactive loop (2026-07-26)

### What changed

- New opt-in flag `--grok-neo` (`src/cli/args.ts`, gate `src/cli/grok-neo-gate.ts`): `SENPI_ENABLE_GROK_NEO` accepts `1`/`true`/`yes`, default OFF. When the gate is off the flag is absent from `--help` and parses as an unknown extension flag, exactly as if the feature did not exist. When on, it runs the ordinary interactive mode with the grok chrome (`chrome: "grok"` dispatch in `main.ts`) — same senpi process, no separate binary or daemon.
- New built-in themes `grok-night` and `grok-day` (`src/modes/interactive/theme/grok-night.json` / `grok-day.json`, registered in `getBuiltinThemes()` in `src/modes/interactive/theme/theme.ts`). Precedence: an existing settings theme always wins; `grok-night` is only an in-memory fallback when no theme was ever chosen (`applyGrokNeoThemeFallback` in `main.ts`) and is never written to `settings.json`. `--theme` registers theme resources; it does not select one.
- Chrome components under `src/modes/interactive/grok/`: rounded input card, compact footer (model + cwd only), welcome card, single-line tool rows with a `┃`/`◆` guide column, braille working indicator, and a palette/chrome-token layer that resolves colour through the active theme.
- User docs: `docs/grok-neo.md` (mode, gate, themes, in-process architecture, experimental status, independent-reimplementation and non-affiliation statement) plus a `docs/docs.json` navigation entry.

### Why

- Replaces the removed out-of-process Go TUI with an in-process presentation layer: one process and one deployable directory for the Bun binary (native addons ship as sidecars), with the classic TUI unchanged as the default.

### Expected merge conflict zones on next upstream sync

- LOW: additive seams only — the gate module, one conditional branch each in `args.ts` parse/help, the theme-fallback and `chrome` dispatch lines in `main.ts`, and the `grok-night`/`grok-day` registration in `theme.ts`.

## Extension user-message injections are retained when the prompt path rejects (2026-07-26)

- `core/agent-session.ts`: `sendUserMessage()` now tracks the prompt disposition. When `prompt()` rejects before the message reaches a queue or a turn (e.g. a required compaction that cannot complete, auth/model validation, or provider admission), the message is queued for later delivery (`deliverAs: "steer"` goes to the steering queue, otherwise the followUp queue) instead of being silently dropped. The rejection still propagates, so fire-and-forget extension bindings keep emitting their `send_user_message` error event.
- Root cause of the omo `team_wait` starvation forensics: member self-poller injections via `pi.sendUserMessage(..., { deliverAs: "followUp" })` vanished without a trace when the fresh-prompt path threw, leaving no record in the session JSONL while RPC-path `steer`/`follow_up` commands (which bypass `prompt()`) landed normally.
- Interactive `prompt()` behavior is unchanged: a rejected interactive prompt still drops the input and surfaces the error to the user (pinned by `test/suite/regressions/pre-prompt-compaction-no-continue.test.ts`).
- Coverage: `test/suite/agent-session-extension-injection.test.ts` pins retention for followUp and steer injections, exact-once delivery after recovery through the post-run drain, and no double-queueing on the streaming accept path.

## Reload-safe MCP preservation and extension-removal lifecycle event (2026-07-26)

- `session_extensions_removed` is emitted on the old extension runner when a `/reload` or a session replacement (`/new`, `/resume`, `/fork`, import) rebuilds the extension set. Its payload is `{ type: "session_extensions_removed", reason: SessionShutdownEvent["reason"], removed: Array<{ path, resolvedPath }> }`, allowing an extension that did not survive the rebuild to release resources after the new settings and active builtin set are known.
- Unchanged MCP servers now survive a classic `/reload`: the shared service reattaches and reconciles by config hash, preserving live connections while replacing changed servers and disposing removed ones. Provider-scoped MCP services still dispose on reload because their factory creates a replacement instance.
- If the MCP builtin itself is disabled during a reload or replacement, its removal event disposes the preserved classic service so stdio children cannot leak. For an otherwise wedged server, use `/mcp reconnect <name>` to force a fresh connection.

## Same-model-first transient retries and capped server waits (2026-07-26)

### What changed

- Supersedes the 2026-07-20 entry's sentence "retryable transient failures now switch to a configured fallback ...": transient retryable failures (timeouts, overload, 429, 5xx, transport drops) now retry the same model on the existing exponential backoff until `retry.maxRetries` is spent; only then does the configured `retry.fallbackChains` chain engage, and each fallback candidate starts with a fresh retry budget.
- `core/agent-session.ts`: `retry.provider.maxRetryDelayMs` (default 60000) now bounds the server-requested wait honored on the same model. Beyond the cap the fallback chain engages and the primary is suppressed for the requested duration; the turn fails with an informative error only when no chain candidate is available. Waits at or below the cap are honored as before.
- `core/retry-fallback/cooldown.ts`: timeout and connection/transport errors now carry a 60-second selector cooldown instead of the five-minute unmatched default, so revert-to-primary is no longer blocked for five minutes after one network blip. Existing tiers keep precedence: quota/billing 30 minutes, rate-limit 30 seconds, capacity 45 seconds plus jitter, 5xx 20 seconds, and a provider retry-after hint always wins.
- Unchanged: classifier-refusal fallback (immediate, pinned), hard-error fallback (quota/auth/model-not-found, immediate), and `retry.abortServerSideFallback` (default true) routing provider-side model substitution onto the configured chain.
- Cost/latency: with `retry.maxRetries >= 1` a fully failing chain now costs up to `1 + (chainLength + 1) * maxRetries` provider calls plus per-rung backoff before the turn fails; with `maxRetries: 0` every failure switches immediately, costing `1 + chainLength` calls.
## OMO local plugin remote-diff updater beta on bare `senpi update` (2026-07-26)

- A bare `senpi update` now triggers the beta OMO local-update hook (`src/beta/omo-local-update.ts`, reachable only through the two BETA-marked touch points in `package-manager-cli.ts`) before any self-update work. The hook compares the state of the two packages (`omo-senpi` + `senpi-task`) on `origin/dev` of the OMO source checkout against the locally installed modules, and updates the local install ONLY when they differ.
- The user's checkout receives ZERO git mutations: the hook performs one read-only `git fetch origin dev`, builds in a feature-owned persistent worktree under the agent directory, and atomically swaps the installed plugin directory by rename. No checkout/branch/commit/merge/reset/clean/stash/push ever touches the user's tree.
- `SENPI_OMO_LOCAL_UPDATE=0` is a kill-switch that disables the hook entirely. All failures are non-fatal: the hook never throws and never sets `process.exitCode`; any error downgrades to a warning plus a manual-update hint so the `senpi` self-update proceeds untouched.
- Fast path (2026-07-29): the skip decision now compares a build-input fingerprint of `origin/dev` (`src/beta/omo-local-update-fingerprint.ts`: sha256 over root tree entries minus documentation/agent-config paths) instead of the bare commit sha, so docs/CI-only churn in the omo monorepo no longer triggers the ~30s rebuild. When a rebuild IS needed, the bare-update foreground now only fetches and compares (~1s) and hands the build to a detached worker (`src/beta/omo-local-update-worker.ts`, hidden `senpi update --omo-local-update-worker` flag, output to `<agentDir>/omo-local-update/worker.log`); the worker serializes through the existing pid lock and swaps/stamps exactly like the former inline path. `SENPI_OMO_LOCAL_UPDATE_SYNC=1` restores the old blocking foreground behavior.
- The fast skip also checks the updater's current required-artifact contract independently of the historical stamp inventory. A legacy, stale, or externally damaged stamp can no longer hide a missing packaged LSP daemon CLI; the next update rebuilds and atomically repairs the plugin.
- Removal is exactly three steps: delete all `src/beta/omo-local-update*.ts` files; delete all `test/omo-local-update*` files; delete the BETA-marked touch points (the import, the hook calls, and the `--omo-local-update-worker` flag) in `package-manager-cli.ts`.

## App-server daemon launch diagnostics and hermetic lifecycle coverage (2026-07-24)

- The daemon launcher now classifies websocket listener occupancy before spawn: a compatible app-server answers `initialize` and attaches, while any other TCP listener fails immediately with an `EADDRINUSE` diagnostic instead of consuming the child readiness budget. Child-process startup stderr still accompanies actual post-spawn failures, and each launch replaces stale diagnostics.
- The real-CLI daemon lifecycle test isolates home/XDG state, verifies the pre-spawn occupied-port diagnostic and that it does not create a child stderr log, retries the bounded QA port pool, and awaits lock/process events rather than polling sleeps.

## Manual compaction keeps agent lifecycle subscription through abort (2026-07-24)

- `core/agent-session.ts`: manual or extension-initiated compaction claims its synchronous admission/barrier first,
  then aborts and waits for the active agent run while still subscribed. The abort's `agent_end` now clears the
  active-run and retry state before compaction disconnects for summary generation; all disconnected exits reconnect.
- Regression: `test/suite/compaction-race.test.ts` covers compaction during a live provider stream and asserts the
  aborted `agent_end` precedes compaction startup without deadlocking future prompts.

## Removed the legacy `--neo` Go TUI surface (2026-07-26)

### What changed

- Removed the Go TUI launcher, daemon dispatch, CLI flags, settings, documentation, build gate, and the retired Go package. The classic interactive and `--mode rpc` paths remain unchanged.
- Migrated generic RPC authentication and connection-handler framing coverage into `test/suite/rpc-auth-and-connection-handler.test.ts` before deleting the legacy-specific suites.

### Why

- The legacy out-of-process TUI and its daemon are no longer part of the supported CLI surface.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only changes across fork-owned legacy surfaces.

## Inspector handoff and VM-import crash isolation (2026-07-24)

### What changed

- The launcher closes an inherited startup Inspector endpoint immediately before spawning `cli-main`, allowing the
  child process to bind the same configured endpoint instead of failing with `address already in use`.
- With `SENPI_RECOVER_INSPECTOR_VM_IMPORT=1` set at process start, interactive mode recovers only the exact unhandled
  Inspector-eval rejection produced when `import()` runs without a VM dynamic-import callback. Recovery is fail-closed
  by default; application-owned VM failures and unrelated uncaught exceptions remain fatal.

### Why

- The launcher and child previously inherited one fixed Inspector port, so developers attached to the wrapper rather
  than the TUI process. Running asynchronous `import()` in Node's Inspector VM then terminated the attached process.
  Node exposes no non-spoofable Inspector provenance on the global exception, so continuing requires an explicit
  developer opt-in rather than weakening the default fatal boundary.

### Why extension system couldn't handle this

- Inspector ownership is decided before extensions load, and process-wide uncaught-exception handling belongs to the
  host's terminal-restoration boundary.

### Expected merge conflict zones

- LOW: `cli.ts` immediately before the `cli-main` spawn.
- LOW: `modes/interactive/interactive-mode.ts` uncaught-exception handler.

## Reload measurement and redundant-work removal (2026-07-26)

- `/reload` records a `reload` timing namespace with one marker per phase
  (`shutdown`, `settings`, `models`, `resources`, `runtime`, `chatRebuild`,
  `lifecycle`). With `PI_TIMING=1` the breakdown is appended to the reload
  status line; with it unset nothing is recorded.
- Settings are read once per reload instead of twice.
  `ResourceLoaderReloadOptions.settingsAlreadyReloadedFor` takes the
  `SettingsManager` the caller just reloaded, and the loader skips its own
  reload only when that is the very manager it owns AND project trust is not
  being resolved, so trust-scoped values can never go stale.
- `ModelRuntime.reloadConfig()` delegates to `refresh()` instead of repeating
  the config load and provider rebuild that `refresh()` performs immediately
  afterwards.
- Both model-scope resolutions read the snapshot the reload refresh just
  produced rather than each triggering another availability scan (3 scans -> 1).
  The snapshot is trusted only via `hasFreshAvailabilitySnapshot()`; a failed
  refresh falls back to the runtime so scan errors still surface.
- `scripts/bench-reload.mjs` measures `DefaultResourceLoader.reload()` from
  source through a subprocess probe (real jiti path), reporting cold-first and
  warm p50/p95 across fresh processes.
## Multi-session RPC mode, session-owned MCP/config-reload state, and back-compat guarantee (2026-07-23)

### What changed

- `src/modes/rpc/`: new `--multi-session` startup flag. `senpi --mode rpc --multi-session`
  constructs NO default session (no default `AgentSessionRuntime`, no default extension/watcher load).
  Mode is fixed at process start; there is no runtime transition. New modules: `session-registry.ts`,
  `session-command-router.ts`, `session-binding.ts`, `multi-session-host.ts` (each ≤250 pure LOC).
- Multi-session wire protocol per the D1 normative table (see `docs/rpc.md` → Multi-session mode, and
  the `rpc-mode.ts` header doc block for the verbatim table): `get_protocol_info` (answered in BOTH
  modes; side-effect-free; THE capability probe), `open_session` / `close_session` / `list_sessions`,
  mandatory `sessionId` routing on session-scoped commands, `sessionId` tagging on all session-owned
  output, stable error codes (`unknown_session`, `session_closing`, `session_path_in_use`,
  `missing_session_id`, `multi_session_disabled`, `invalid_path`, `open_failed: <detail>`), identities
  (D6: response-level `sessionId` = opaque routing handle, ephemeral per process epoch;
  `state.sessionId` = durable JSONL identity), and the D9 ordering guarantee (strict FIFO per session,
  one total stdout order, fair round-robin between sessions' queued complete records, NO cross-session
  batch coalescing, starvation freedom NOT promised).
- `src/core/extensions/builtin/mcp/` and `src/core/extensions/builtin/config-reload/`: in multi-session
  mode each session OWNS its MCP service instance (extension factory closes over it; helpers take the
  instance, never call the `getMcpService()` global getter), its elicitation/instructions/prompts state,
  and its `reloadHandoff` keyed by the session handle. Classic single-session mode keeps the globals
  (no behavior change).
- Session-owned config-reload state: the fs-watcher reload chain
  (`config-reload/index.ts` → `agent-session.ts:3807` `resetApiProviders()`) is scoped per session via
  the pi-ai provider scope, so reloading session A cannot reset session B's providers.

### Why

- A single shared `senpi --mode rpc --multi-session` process serves all of a provider instance's
  threads concurrently. Cross-session turns run concurrently; per-session turn serialization comes
  from `AgentSession`. Session-scoped state (provider registry, MCP, config-reload) must be owned by
  the session so one conversation can never corrupt another.

### Back-compat guarantee

- Classic single-session mode (`senpi --mode rpc`, no flag) is byte-identical to today. The ONLY
  additive classic-mode behavior is that `get_protocol_info` is answered (side-effect-free). Existing
  RPC tests, the classic-compat characterization pin suite, and the neo-daemon suites stay green
  unchanged.

### Explicit non-goal

- Per-session AuthStorage / multi-tenant key isolation is NOT added inside the shared process. The
  process is single-tenant; tenancy isolation remains the neo daemon's job (per-connection worker
  model). The neo daemon's behavior and its header distrust rationale are unchanged.

### Why extension system couldn't handle this

- Session lifecycle, the multi-session host/router/registry, MCP service ownership, and config-reload
  handoff are protocol and core-runtime infrastructure below the extension boundary.

### Expected merge conflict zones on next upstream sync

- HIGH: `src/modes/rpc/` (new multi-session modules + `rpc-mode.ts`/`connection-handler.ts` seams).
- MEDIUM: `src/core/extensions/builtin/mcp/service.ts` global getter removal on the multi-session path.
- LOW: `src/core/extensions/builtin/config-reload/index.ts` reloadHandoff keying.

## App-server web-search projection and cumulative turn diffs (2026-07-21)

### What changed

- `modes/app-server/threads/`: projects only OpenAI `web_search_call` metadata into the structured Codex `webSearch`
  shape, preserves readable generic provider-native items for other subtypes, and emits subscriber-only
  `turn/diff/updated` notifications rebuilt from per-tool patches in file-change source order.
- `core/tools/` and `core/extensions/builtin/gpt-apply-patch/`: preserve source-backed unified patches for real edit,
  write, multi-file, partial-success, repeated same-path, dependent sequential, and move-only results.
- Non-empty app-server `fileChange` changes use the generated v2 tagged kind shape; moves retain the source path,
  expose the destination in `move_path`, and carry an applicable delete/add-or-update representation.
- `test/suite/` and `test/qa/app-server/`: cover final web-search payload fidelity, concurrent completion ordering, real
  mutation result shapes, per-turn reset, notification envelopes, subscriber routing, and a zero-token source-CLI run.

### Why

- Codex app-server clients render native web-search activity and live file-change previews from these item and
  notification contracts; synthesized fields and missing diffs break that client experience.

### Why extension system couldn't handle this

- Provider-native item projection, turn-scoped diff state, and subscriber notification routing are app-server protocol
  infrastructure below the extension boundary; source patches must be captured by each mutation tool before apply.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/threads/projection*.ts` implementation and its app-server QA fixtures.
- MEDIUM: write/apply_patch result details where source baselines are captured.

## Fuzzy file search one-shot and sessions (2026-07-21)

### What changed

- `modes/app-server/search/`: added bounded deterministic file traversal, subsequence scoring, same-token one-shot
  cancellation, and replaceable query sessions with latest-query update and completion notifications.
- `modes/app-server/runtime.ts` and `server/notifications.ts`: registered the stable one-shot method plus the three
  experimental session methods, routed the two stable session notifications globally, and cancelled outstanding work on
  runtime teardown.
- `test/suite/` and `test/qa/app-server/`: pinned traversal/scoring limits, cancellation and session races, request
  gates, ungated notification fanout, manifest status, and a zero-token source-CLI fixture-tree scenario.

### Why

- Codex clients use fuzzy file search for path completion and rely on cancellation tokens and long-lived sessions to
  avoid stale results while a query changes rapidly.

### Why extension system couldn't handle this

- File-search requests and global app-server notifications are transport-level JSON-RPC behavior below the extension
  boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/search/` implementation and app-server registration/router allowlists.

## Wave 2 app-server parity verifier corrections (2026-07-20)

### What changed

- `modes/app-server/protocol/`: corrected fuzzy-search result keys to Codex's snake-case wire names and completed the
  handwritten thread-item/history facade so runtime modules no longer import generated protocol files directly.
- `modes/app-server/threads/`: made source-kind parsing strict, applied Codex's interactive-session default when search
  source filters are omitted or empty, rejected malformed search `u32`/boolean fields, separated user-activity recency
  from general updates, persisted unarchive timestamp bumps, rejected non-`u32` history limits, preserved every
  projected history-item variant plus completed-turn lifecycle data, read cold history without loading the thread,
  deferred compact work and `item/started` until after the RPC acknowledgement, and recorded rejected compactions as
  failed without fabricating a completed item.
- `modes/app-server/server/models.ts`: validates `remoteControl/client/list` parameters before returning the honest
  no-remote-control internal error.
- `test/qa/app-server/`: extended the Todo 8–12 drivers for the rejected edge cases and made the compaction fixture
  exercise explicit manual compaction without being preempted by automatic compaction.

### Why

- Independent parity verification found boundary-validation, persistence, timestamp, import-layer, and failure-path
  mismatches that the first wave's happy-path tests did not distinguish from Codex HEAD behavior.

### Why extension system couldn't handle this

- These contracts are JSON-RPC parsing, thread persistence/projection, and app-server lifecycle behavior below the
  extension boundary.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` and app-server QA surfaces. Preserve Codex wire names and re-run the focused
  verifier drivers if upstream session timestamp or compaction behavior changes.

## Codex HEAD app-server catalogs, facade, and terminal envelopes (2026-07-20)

### What changed

- `modes/app-server/protocol/`: aligned method catalogs with the pinned Codex HEAD source, added complete experimental
  notification metadata, and added handwritten facade types for the catalog, config, account, collaboration-mode,
  fuzzy-search, thread-parity, terminal-error, and notification-envelope surfaces selected by the parity plan.
- `modes/app-server/server/connection.ts`, `server/notifications.ts`, `rpc/envelope.ts`, `rpc/ndjson.ts`: gate
  experimental notifications from the shared catalog and populate one `emittedAtMs` timestamp per notification before
  fanout, preserving it through final transport serialization while leaving server requests untouched.
- `modes/app-server/server/server-core.ts`: added post-response deferred actions so later thread handlers can guarantee
  response-before-notification ordering.
- `modes/app-server/threads/turns.ts`, `turn-adapter.ts`, `threads/projection.ts`: replaced the fork-only terminal
  `turn/failed` wire event with Codex HEAD's ordered `error` plus failed `turn/completed` pair, sharing one `TurnError`.
- `modes/app-server/server/models.ts`: moved model catalog runtime typing onto the handwritten facade while retaining the
  existing remote-control behavior for its dedicated follow-up task.

### Why

- Codex's generated TypeScript exporter omits experimental request roots and cannot by itself describe the live HEAD
  catalog. Senpi needs a stable, Node-compatible facade derived from both the pinned source inventory and generated
  evidence.
- Current Codex clients expect populated notification timestamps, capability-aware experimental delivery, and terminal
  failures expressed through the canonical error/completion pair.

### Why extension system couldn't handle this

- Method catalogs, transport envelopes, response-frame ordering, and terminal event projection are app-server protocol
  infrastructure that runs outside the coding-agent extension surface.

### Expected merge conflict zones on next upstream sync

- LOW: the fork-only `modes/app-server/` tree. Re-derive catalogs and facade shapes from the new Codex source before
  resolving conflicts; never hand-edit `protocol/generated/**`.

## Parallel side questions via `/btw` (2026-07-21)

### What changed

- New builtin extension `core/extensions/builtin/btw/` adds `/btw <question>`: a read-only side LLM query against a synchronously captured snapshot of the current conversation, running in parallel with any in-flight main turn without writing to session history. Details in `core/extensions/builtin/btw/changes.md`.
- TUI: the answer streams into a dismissable widget above the editor; Escape dismisses the side panel without touching main-turn Escape behavior. Non-TUI modes deliver the answer via `ctx.ui.notify`.
- `core/extensions/builtin/index.ts` registers the extension between `goal` and `mcp`.

### Why

- Asking a question about the ongoing session previously required waiting for the main turn and polluting its context. `/btw` answers immediately, in parallel, and leaves the main session untouched.

## Claude text tool-call recovery (2026-07-20)

### What changed

- `core/model-runtime.ts`: both streaming entry points conditionally wrap prepared provider streams through the side-effect-free AI recovery API, using the original selected model and non-empty tools while keeping provider retries/auth/request preparation underneath a single wrapper.
- `core/model-config.ts` and `core/provider-composer.ts`: custom definitions, built-in overrides, and extension models accept the top-level tri-state `recoverTextToolCalls` boolean without using `compat`.
- Session and agent-loop integration tests prove complete and truncated raw Anthropic/OpenAI SSE recovery, safe non-execution, persisted native history, provider-native next-turn replay, original historical XML preservation, and retry-attempt isolation.
- The isolated senpi-qa mock loop now exposes complete/truncated leak modes for both supported APIs, hashes real auth before/after, and captures cleanup/evidence receipts.

### Why

- Provider-specific middleware cannot enforce the cross-provider persistence, retry, abort, ordering, and execution boundaries required after a model leaks XML as assistant text.

- `core/agent-session.ts` and `core/retry-fallback/controller.ts`: non-retryable provider errors now advance immediately through an eligible fallback chain without replaying the failed model or waiting for backoff. Hard-failing selectors receive the normal session-local cooldown; overflows, aborted responses, refusals, and error responses containing tool calls continue to settle through their existing paths.

- `core/agent-session.ts`: typed classifier refusals now bypass same-model retries and immediately advance through a pinned fallback chain without cooldowns. Switched refusal messages are removed from active context while retained in session history; exhausted chains leave only the final refusal visible.

- `ExtensionContext.sessionSettings` now gives the model-fallback builtin the live session-owned retry settings and retry status; `/fallback` writes are immediately visible to the retry controller, while `--no-model-fallback` and `SENPI_NO_FALLBACK=1` apply a non-persistent session override.

- `core/agent-session.ts` now centralizes active-model switching, preserving manual selection behavior while supporting non-persistent, non-notifying ephemeral fallback switches.
- `core/session-manager.ts` records optional fallback model-change metadata and restores the primary model rather than a fallback-period assistant model after restart.

- `core/retry-fallback/validate.ts`: validate fallback-chain configuration with deterministic warnings.

- `core/retry-fallback/log.ts`: add a bounded, sanitized 0600 NDJSON fallback debug logger.

## Retry fallback settings (2026-07-20)

### What changed

- `core/settings-manager.ts` now persists global per-model retry fallback chains, fallback enablement, and the
  fallback revert policy. Reads provide safe defaults when those optional settings are unset or malformed.
- Project `retry` settings retain the established one-level merge behavior: a project `fallbackChains` map replaces
  the global map rather than merging individual chain keys.

### Why

- Model fallback behavior needs a durable, user-configurable chain without adding another settings file or allowing
  fallback controls to write project settings.


- `core/retry-fallback/chains.ts`: adds pure, canonical selector parsing and fallback-chain resolution.

- `core/retry-fallback/cooldown.ts`: adds per-session, lazy-expiry selector cooldowns with provider retry-after and error-derived durations.

## Accepted compaction resumes the waiting prompt (2026-07-20)

### What changed

- `agent-session.ts`: the pre-prompt fail-closed check now recognizes an assistant response retained behind the latest accepted compaction boundary as historical usage. A prompt waiting on compaction therefore dispatches with compacted history, while cancelled or would-overflow compaction remains blocked before any provider request.
- `agent-session-compaction.test.ts`: added a provider-dispatch regression for irreducibly oversized pre-prompt compaction results.

### Why extension system couldn't handle this

- `AgentSession` owns the compaction boundary, stale usage classification, prompt settlement barrier, and the provider-dispatch decision. Extensions can propose or reject summaries but cannot serialize this state transition.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-session.ts` around `prompt()`, `_checkCompaction()`, and compaction-boundary stale-message checks.

## Model-runtime upstream model id and model-config service tier (2026-07-19)

### What changed

- `core/model-runtime.ts`: `prepareRequest()` now swaps the wire model id to the models.json/extension
  `upstreamModelId`. Previously only the compaction and websearch extensions honored it, so main-loop requests sent
  the configured alias id (e.g. `gpt-5.6-terra-fast`) verbatim and upstreams rejected the unknown model.
- `core/agent-session.ts`: `_currentServiceTier` now falls back to the model's configured `serviceTier` from the
  compatibility request config (models.json / extension model definition) when no scoped/favorite tier is set
  (`_resolveServiceTier`). The builtin service-tier extension then injects `service_tier` into OpenAI Responses
  payloads through `before_provider_request`, so client-configured priority tiers reach the wire.

### Why

- models.json `-fast` pseudo-models declare `upstreamModelId` + `serviceTier: priority` so priority-tier requests are
  client-controlled instead of proxy-side per-model overrides; the main request path must honor them.
  (`extraBody.service_tier` is not a viable channel: it is an OpenAI Responses reserved body key.)

### Why extension system couldn't handle this

- `prepareRequest()` is the core chokepoint every stream/complete call funnels through; extensions cannot rewrite the
  wire model id for the main loop, and the builtin service-tier extension only sees the session tier, which never
  reflected model-level configuration.

### Expected merge conflict zones on next upstream sync

- LOW: `model-runtime.ts` `prepareRequest()` body; `agent-session.ts` service-tier assignment sites.

## Paced streaming tool argument previews (2026-07-20)

### What changed

- `modes/interactive/tool-args-reveal.ts` paces append-only partial JSON independently per tool call, reusing the smooth
  streaming FPS and catch-up policy while batching parser work and preserving UTF-16 surrogate boundaries.
- `modes/interactive/interactive-mode.ts` flushes exact arguments before completion or execution and tears down reveal
  state anywhere pending tool components are cleared.

### Why

- Provider bursts should not make large tool-call previews jump or force a full partial-JSON parse for every timer tick.

### Why extension system couldn't handle this

- Pending tool components and their streaming/execution transition state are private to the built-in interactive mode.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

- MEDIUM: interactive tool-call event handling and smooth-streaming settings callbacks.
- LOW: the fork-only reveal controller.

## Smooth streaming reveal (2026-07-20)

### What changed

- `modes/interactive/streaming-reveal.ts`: adds a grapheme-safe, time-based controller that reveals streamed assistant
  text at a stable perceived rate from 30–120fps, catches up bounded backlogs, and flushes immediately at tool-call and
  lifecycle boundaries.
- `core/settings-manager.ts` and the interactive settings selector persist smooth-streaming enablement and FPS.
- `modes/interactive/interactive-mode.ts` routes assistant deltas through the controller and tears it down on final,
  abort, session-switch, and shutdown paths.

### Why

- Provider chunks often arrive in bursts; rendering each burst verbatim makes otherwise fast responses visually jumpy.

### Why extension system couldn't handle this

- The controller owns private in-flight assistant component updates, TUI render scheduling, and session lifecycle state.

### Expected merge conflict zones on next upstream sync

- MEDIUM: interactive assistant event handling and settings-selector plumbing.
- LOW: the fork-only reveal controller and settings accessors.

## Incremental assistant message re-render (2026-07-19)

### What changed

- `modes/interactive/components/assistant-message.ts`: assistant content is now planned as flat render descriptors
  and reconciled against the previous child list. Unchanged children stay mounted, growing text/thinking Markdown
  updates through `Markdown.setText()`, and structural changes rebuild only the divergent suffix.
- `../test/assistant-message-incremental-render.test.ts`: exact raw-render parity covers text, thinking,
  provider-native blocks, error tails, hidden thinking, expansion, and output padding; identity assertions pin the
  incremental reuse contract.

### Why

- Streaming updates previously cleared the entire content container, so every delta recreated all Markdown children
  and discarded their instance render caches even when only the final block grew.

### Why extension system couldn't handle this

- The built-in assistant component owns transcript child identity, disposal, render caching, and OSC marker behavior;
  extensions cannot reconcile its private render tree.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `modes/interactive/components/assistant-message.ts` around content construction and streaming cache reuse.

## Neo launch handoff and daemon dispatch (2026-07-06)

### What changed

- `main.ts`: `--neo` / `--neo-isolated` (+ hidden `--neo-bin`) dispatch to the neo Go TUI launcher (`cli/neo/`),
  spawning the per-platform binary with inherited stdio, forwarded signals, and propagated exit code/signal. Dispatch
  sits after the version/export fast-paths and first-time setup, before any `AgentSessionRuntime` construction or
  extension loading, so the launcher stays thin.
- `main.ts`: `--listen <path>` dispatches to the neo daemon supervisor (see `modes/rpc/changes.md` 2026-07-06). The
  `NeoRuntimeOptions` field list is gated by a generated extraction test over `main.ts` `parsed.*` reads, so new
  runtime-relevant flags fail the test until threaded through.

### Why

- The neo TUI is a separate Go binary; senpi remains the single user-facing entrypoint and must hand off cleanly.

### Why extension system couldn't handle this

- Mode dispatch happens in `main()` before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` mode-dispatch ordering around startup fast-paths.

## App-server mode dispatch (2026-07-02)

### What changed

- `main.ts`: added dispatch for the fork's `senpi app-server` subcommand into `modes/app-server/` (transports,
  daemon supervision, thread lifecycle), hardened on 2026-07-03 with review fixes (entrypoint split, archive-state
  handling). Arg plumbing is in `cli/changes.md`; the mode directory itself does not exist upstream.

### Why

- Codex-compatible app-server clients need a first-class mode entrypoint next to interactive/print/rpc.

### Why extension system couldn't handle this

- Modes are dispatched from `main()` before extension loading; a wire-protocol server cannot be an extension.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `main.ts` around mode selection and subcommand routing.

## Public model resolution SDK exports (2026-07-02)

### What changed

- `index.ts`: accepted upstream exports for CLI-equivalent model and scoped-model resolution helpers.
- Documentation and examples were updated to describe extension entry renderers and the public SDK surface.

### Why

- External integrations need the same model-resolution behavior the CLI uses without duplicating internal resolver logic.

### Why extension system couldn't handle this

- Public package exports and SDK documentation are package API surfaces. Extensions can consume the exported helpers after
  load, but they cannot publish or document the root module exports themselves.

### Expected merge conflict zones on next upstream sync

- LOW: `index.ts` export list if upstream changes public SDK exports.
- LOW: docs/examples around extension entry renderer examples and model-resolution helper documentation.

## Nested legacy config migration (2026-07-01)

### What changed

- `migrations.ts`: split legacy directory and extension-system migrations into focused modules.
- `legacy-senpi-dir-migration.ts`: migrates missing files from nested legacy `~/.senpi/.pi/agent` and `~/.senpi/.pi/mom` directories into the current senpi config layout without overwriting existing files.

### Why

- Some pre-rename local configs ended up under nested `~/.senpi/.pi/agent`, so a fresh `~/.senpi/agent` could strand custom `models.json` entries such as ccapi-routed Anthropic models.

### Expected merge conflict zones on next upstream sync

- LOW: startup migration orchestration in `migrations.ts`.

## shared provider-native rendering in text output (2026-05-14)

### What changed

- `modes/provider-native-rendering.ts`: added shared provider-native formatting for Anthropic, OpenAI, and Google native web-search metadata, with a generic JSON fallback for unknown provider-native blocks.
- `modes/print-mode.ts`: text print mode now emits provider-native summaries and bodies through the shared formatter instead of silently skipping provider-native content.

### Why

- Native web-search metadata should be readable outside the interactive TUI as well, and the compact rendering rules should stay consistent between interactive and print surfaces.

### Why extension system couldn't handle this

- Print mode emits assistant content directly after the session finishes; extension tool renderers do not own provider-native assistant content.

### Expected merge conflict zones on next upstream sync

- LOW: `modes/print-mode.ts` final assistant-content emission and `modes/provider-native-rendering.ts` if upstream adds its own provider-native formatter.

## CLI export tilde expansion (2026-05-13)

### What changed

- `main.ts`: `senpi --export ~/session.jsonl ~/out.html` expands leading `~` for both the input session path and optional output path before exporting.

### Why

- The interactive `/export` bug also affected the non-interactive export path because Node's path resolution treats `~` as a literal directory name.

### Why extension system couldn't handle this

- `--export` exits before interactive mode and extension command handlers run, so CLI path normalization must happen in `main.ts`.

### Expected merge conflict zones on next upstream sync

- LOW: `main.ts` around the early `parsed.export` branch.

## Senpi self-update release source (2026-05-02)

### What changed

- `config.ts`: Bun-binary self-update fallback now points to `code-yeongyu/senpi` releases.
- `package-manager-cli.ts`: `senpi update senpi` is accepted as the branded self-update target and help text uses senpi wording.
- `package.json`: Repository metadata now points to the senpi fork.

### Why

- Self-update messaging and release metadata should direct users to senpi, not upstream pi-mono.

### Why extension system couldn't handle this

- These are core package metadata and built-in package-command parsing paths that run before extensions participate.

### Expected merge conflict zones on next upstream sync

- LOW: self-update command parsing/help and package metadata.

## Per-model transient retry fallback engine (2026-07-20)

### What changed

- `core/retry-fallback/controller.ts`: added the session-local fallback-chain controller. It canonicalizes configured selectors, suppresses transiently failing models, skips unavailable candidates with scoped logging, applies ephemeral thinking levels, and emits fallback lifecycle events.
- `core/agent-session.ts`: retryable transient failures now switch to a configured fallback without persisting the selected model, emitting a zero-delay retry and retaining the existing failed-assistant removal behavior. A fallback success event is emitted after the next successful response.

### Why extension system couldn't handle this

The retry budget, abortable retry sleep, provider continuation, and active model state all belong to `AgentSession`; an extension cannot safely replace a model inside that lifecycle without persisting it or rebuilding context.
- Retry fallback revert-to-primary at turn boundaries: unpinned fallback state under the `cooldown-expiry` policy restores the original model once its selector cooldown lapses (checked at prompt entry and between the retry sleep and continuation), emits `retry_fallback_reverted`, preserves user thinking-level overrides, and is abandoned on manual `setModel`/`cycleModel` (which also abort a pending fallback retry sleep).
- Server-side fallback aborts (2026-07-25): `retry.abortServerSideFallback` (default true) forwards `abortServerSideFallback` into provider stream options via a new `Agent` field and `createLoopConfig`. `AgentSession` translates the provider's `server_fallback_aborted` diagnostic into a session event of the same name carrying `from`/`to`/`chainConfigured`, emitted synchronously from `message_end` so it precedes refusal retry handling, and the existing refusal path then routes the turn onto the configured chain. `RetryFallbackController.hasConfiguredChain()` distinguishes "no chain configured" from "chain spent", because the no-chain refusal path emits no `retry_fallback_exhausted`. Interactive mode renders the abort and names `/fallback` when no chain exists.

## Session lifecycle stuck-route logging (2026-07-30)

### What changed

- `core/session-log.ts`: new rotating content-free JSONL logger writing `<agentDir>/logs/session.log` (5MB rotate, allow-listed scalar fields, secret redaction, `SENPI_SESSION_DEBUG=1` stderr mirror), following the existing `retry-fallback/log.ts` pattern.
- `core/agent-session.ts`: mirrors stuck-prone lifecycle transitions into `session.log`: `compaction_decision` on every terminal `compaction_end` (reason/accepted/aborted/willRetry/rejectionCause/error), `provider_error` on assistant `message_end` errors classified as stall/timeout/error, `queue_enqueue` on native steer/followUp queueing, and `prompt_rejected` when a `RequiredCompactionError` rejects prompt admission.
- Compaction lifecycle records now correlate start/terminal events with propagated UUID request IDs; classify committed/rejected/failed/skipped/aborted/superseded outcomes; record content-free before/after token estimates; preserve retry exhaustion as a skipped no-attempt action; and ignore stale ends from superseded same-reason attempts instead of attributing them to a newer compaction.
- `test/session-log-routes.test.ts` and the compaction lifecycle suites cover unmatched accepted ends, retry exhaustion, rollback snapshots, extension feedback failures, supersession, same-reason stale ends, consecutive compactions, and start/end request-ID parity without real provider calls.
- `modes/interactive/interactive-mode.ts`: logs `compaction_queue_enqueue` when input is parked during compaction, `compaction_queue_deferred` when a failed compaction defers queued input to the native queues, and `clipboard_error` on clipboard paste failures.

### Why extension system couldn't handle this

The instrumented transitions (`_emit`, queue internals, `RequiredCompactionError` admission, the TUI compaction queue, clipboard catch) are private `AgentSession`/`InteractiveMode` state with no extension-visible hook carrying the needed fields; field debugging of "stuck forever" sessions (Discord report 2026-07-30) requires a single post-hoc timeline in the logs directory.

## 2026-08-25 - Upstream public runtime surface sync coverage

### What changed

- `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/index.ts`, `packages/coding-agent/src/modes/rpc/rpc-client.ts`, and `packages/coding-agent/src/modes/rpc/rpc-types.ts` preserve the fork session behavior and public exports while adopting upstream RPC queue clearing and event additions.

### Why

- These runtime and public API paths are directly changed by the upstream sync and require exact nearest-tracker coverage.

### Why this lives in the fork

- Session orchestration and public API exports execute before extension code can compensate for divergence.

### Expected merge conflict zones

- Agent-session event handling, coding-agent barrel exports, and RPC command/client/response unions.
