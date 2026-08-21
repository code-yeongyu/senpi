# claude-sdk-oauth

## 2026-08-21 - Cache provider settings loads by mtime+size to cut lock convoy

### What changed

- `settings.ts`: `loadClaudeSdkOauthProviderSettingsFromDisk` caches the `SettingsManager` instance keyed on (cwd, mtimeMs:size of the global and project settings.json). A cache hit skips `SettingsManager.create` and its two locked disk reads; environment overrides are re-parsed on every call so live env changes take effect immediately.

### Why

- `fallbackEligible()` calls this loader on every retry-fallback candidate probe. A fresh `SettingsManager` per call took the cross-process settings lock twice; under error storms this multiplied into hundreds of locked disk reads per session per error, driving the lock-retry busy-wait (fixed in core) that froze the TUI.

### Why an extension could not handle it

- This IS the extension side: the cache is local to the provider settings loader.

### Expected merge conflict zones

- `settings.ts` around `loadClaudeSdkOauthProviderSettingsFromDisk`.


## 2026-08-20 - Terminate policy refusals without waiting for the stream watchdog

### What changed

- `refusal.ts` recognizes the pinned SDK's terminal `system/model_refusal_no_fallback` message and its documented
  older assistant `message.stop_reason: "refusal"` shape, preserving the policy category and display explanation in a
  typed terminal error. The fallback-retry notice remains non-terminal.
- `auth-lane.ts` classifies that error as non-retryable before account failover, `stream.ts` terminates non-resident
  streams immediately, and `session-registry-pump.ts` settles and closes a resident turn without reading another SDK
  message.
- `test/claude-sdk-oauth-refusal.test.ts` covers structured ambient and resident refusals plus the legacy assistant
  frame, with iterators that fail if consumption proceeds past the refusal.

### Why

Claude policy and cybersecurity refusals can end without an SDK `result` message. The resident pump treated the
refusal notice as an ordinary message and kept waiting for a result, so the provider watchdog fired about 90 seconds
later and the timeout retry ladder re-sent the paid conversation. Refusal is a terminal model decision, not a
stream-start transport failure or an account failover condition.

### Why an extension could not handle it

The dropped signal sits inside this builtin provider's private SDK message consumer and resident query pump. No
external extension hook can settle the active resident turn or prevent its timeout retry after the SDK message has
been consumed here.

### Expected merge conflict zones

- LOW in `auth-lane.ts` at `sdkFailure`, `stream.ts` at the SDK message loop, and `session-registry-pump.ts` at active
  turn message handling.

## 2026-08-20 - Same-turn timeout retries fork at the pre-turn boundary (issue #723)

### What changed

- `session-reattach.ts`: `ContinuityBinding` gained an optional in-memory-only `unansweredTurnDigest`. It
  rides the existing clone/remember paths but is NEVER persisted: `storedBindingFromEntry`
  (`session-binding.ts`) builds the sidecar record from an explicit field list, and the strict
  `schemaVersion: 1` schema (`session-binding-store.ts`) rejects any record carrying it.
  Tests: `test/claude-sdk-oauth-binding-store.test.ts` (round-trip rejects it).
- `session-turn-attempt.ts`: an attempt that pushed its user payload but ended aborted, failed, or
  discarded now remembers a retry checkpoint binding anchored at the PRE-TURN boundary
  (`bindingFromEntry(entry, hashes.slice(0, entry.sentCount))` + the attempted turn's full sent-stream
  digest). Covers the `turn.aborted` resolution, the queue-failure (completion rejected) path, and
  `discard()` before `closeSession`.
- `session-continuity.ts`: `decideFromBinding` gains a branch ahead of the existing prefix logic — when
  the binding carries a checkpoint, the FULL current sent stream hashes to it, and the prefix at
  `binding.sentCount` matches, it returns `fork` at `binding.lastAssistantUuid` (`reason:
  "timeout_retry"`), or the cold-seed `flatten` with the same reason when no boundary exists (first
  turn). A digest mismatch falls through to the pre-existing branches unchanged.
- `session-observability.ts`: `ContinuityReason` union and the sanitizer allowlist admit
  `timeout_retry`. No new event types; one observation per main turn is preserved.
- Tests: `test/suite/regressions/723-claude-sdk-oauth-timeout-abort-retry-continuity.test.ts`,
  `test/claude-sdk-oauth-continuity-decision.test.ts`, `test/claude-sdk-oauth-continuity-retry-checkpoint.test.ts`.

### Why

A stream-start-timeout abort closes the SDK session with the turn's user message already appended and
  un-answered. The retry then re-attached to that lineage and appended the SAME message again — one
  duplicate per attempt, ~8K tokens of cache re-billing per attempt, and for a first turn (no assistant
  boundary, binding absent) a full re-flatten of the whole conversation at full price on every attempt
  (issue #723: $25 per 6 minutes, $1084 over 3 days on worker dispatch). Forking at the pre-turn
  boundary rewinds past the orphaned message, so the retry's request byte-layout matches the failed
  attempt's and the provider serves it from prefix cache; a first turn re-seeds byte-identically
  (flatten is a deterministic function of context), which is likewise cache-read after the first write.

### Why an extension could not handle it

- The retry checkpoint must be recorded where the attempt's outcome is known (`session-turn-attempt.ts`)
  and consumed by the resident-lane continuity decision table (`session-continuity.ts`) — both are
  internal to this builtin's resident session machinery; no extension hook observes attempt outcomes or
  continuity bindings.

### Expected merge conflict zones

- `session-continuity.ts` in `decideFromBinding` (head of the function) — upstream continuity reworks
  touch the same function.
- `session-turn-attempt.ts` attempt-outcome block and `discard()` — same file upstream reworked in the
  2026-08-01 continuity pass.
- `session-reattach.ts` `ContinuityBinding` field list.
- `session-observability.ts` `ContinuityReason` union tail and `SANITIZED_REASONS` set (mechanically
  duplicated literals; both must gain the member).

## 2026-08-20 - SDK bundle loads on first stream instead of at CLI startup

### What changed

- New `sdk-boundary.lazy.ts` owns the single deferred `import("@anthropic-ai/claude-agent-sdk")`, caching the
  module and sharing one in-flight promise across concurrent callers. `sdk-boundary.ts` keeps its synchronous
  `getSdkBoundary()` surface and re-exports `loadClaudeAgentSdk`; its default members read the loaded module
  (`getSessionMessages` is async and self-loads, `query` / `createSdkMcpServer` are synchronous SDK functions
  and therefore require the preload). Its exported types are now derived from the loader's module type instead
  of from value imports.
- The three async entry points that reach a synchronous SDK member now await the loader first:
  `stream.ts` (`streamClaudeSdkOauth`, before `getSdkBoundary().query` and the resident-session lane),
  `session-reattach.ts` (`reattachSession`, before `getOrCreateSession` builds a query), and `custom-tools.ts`
  (`buildCustomToolServers`, now async, before `createSdkMcpServer`). A future call site that skips the preload
  fails with a named error at that call rather than silently restoring the startup import.
- The tiny `@anthropic-ai/claude-agent-sdk/extract` entrypoint used by `executable.ts` is unaffected and stays
  a static import; only the 1.2 MB `sdk.mjs` bundle moved.

### Why

- Importing `dist/main.js` is roughly 70% of CLI boot wall time, and the SDK bundle was parsed and evaluated on
  every start even though only the claude-sdk-oauth streaming lane ever calls into it. Deferring it removes that
  cost from every run that never opens a Claude SDK stream, with no behavior change for runs that do.

### Why an extension could not handle it

- The static import lives in this builtin provider's own SDK boundary module. An extension cannot remove an
  import edge from a module the core already loads, and re-registering the provider id would fork the auth lane,
  session registry, and failover wiring that live here.

### Expected merge conflict zones

- MEDIUM in `sdk-boundary.ts`: the import block and the `defaultSdkBoundary` literal, which upstream also touches
  when adding SDK members. A new member must be added to `sdk-boundary.lazy.ts`'s module projection as well.
- LOW in `stream.ts` and `session-reattach.ts` at the first statement of the async body (the added `await`).
- LOW in `custom-tools.ts` at the `buildCustomToolServers` signature, now async.

## 2026-08-19 - Kill-switched lane leaves implicit fallback expansion

### What changed

- `index.ts`: the provider registration passes `fallbackEligible`, returning false only under the
  verbatim `enabled: false` kill switch. An absent flag and unreadable settings stay eligible, so an
  explicit senpi-side login keeps the lane in bare-family fallback expansion.
  Tests: `test/suite/claude-sdk-oauth-fallback-eligibility.test.ts`.

### Why

- Bare expansion ranked lanes by credential only; a kill-switched lane could still consume an expansion
  slot it is guaranteed to refuse (see `core/extensions/changes.md` 2026-08-19).

### Why an extension could not handle it

- This IS the extension side of the `ProviderConfig.fallbackEligible` registration field.

### Expected merge conflict zones

- `index.ts` provider registration object.
 extension changes

## 2026-08-19 - Ambient auth lane requires an explicit opt-in

### What changed

- New provider setting `claudeSdkOauthProvider.enabled` (boolean, absent means false) plus the matching
  `SENPI_CLAUDE_SDK_OAUTH_ENABLED` env var (`1`/`true`/`0`/`false`, case-insensitive), parsed in `settings.ts` with the
  same boolean style the cursor-cli-oauth sibling uses. It follows the directory's standing precedence rule:
  env > project settings > global settings > default.
- `configuredFor` in `oauth-login.ts` now gates **only** the ambient branch: when the resolved lane is `ambient` and no
  `CLAUDE_CODE_OAUTH_TOKEN*` env account exists, it returns false unless the flag is true, instead of probing the host
  Claude CLI. It remains the single predicate behind both `check` and `resolveAmbient`, so availability and resolution
  still cannot disagree.
- Stored auth.json accounts and env OAuth tokens stay available with the flag unset: an explicit senpi-side login is
  itself the opt-in, so this is not a regression for anyone who ran `/claude-account` or exported a token.
- `index.ts` widens its deliberately narrow `readSettings` projection from `{ tokenInjection }` to
  `{ tokenInjection, enabled }` so the flag reaches the predicate, and accepts an optional `readSettings` extension dep
  (alongside the existing `readAmbientAuthStatus`) so tests can declare a settings block without touching disk.

### Why

- The provider reported itself AVAILABLE merely because the host's Claude Code CLI happened to be logged in: the
  SDK-bundled `claude` binary exits 0 for `auth status`, so on any Mac with Claude Code installed senpi silently spent
  the user's Claude Pro/Max subscription with zero senpi-side consent. Host state is not consent; opt-in must be
  explicit and default to off.

### Why an extension could not handle it

- The predicate is the builtin provider's own `oauth.check` / `oauth.resolveAmbient` pair, constructed inside
  `createOAuthConfig`. An external extension cannot narrow another provider's availability without re-registering the
  provider id, and doing so would fork the auth lane, session registry, and failover wiring that live here.

### Expected merge-conflict zones

- LOW in `settings.ts` (`ClaudeSdkOauthProviderSettings` field list, `parseProviderSettings` and
  `parseEnvironmentSettings` return literals - upstream additions land in the same two literals).
- MEDIUM in `oauth-login.ts` at the `configuredFor` ambient branch, which upstream also touches for lane selection.
- LOW in `index.ts` at the `createOAuthConfig` deps literal.
- LOW in `test/support/claude-sdk-oauth-provider.ts` (`composedProvider` gained a third `settings` parameter) and in the
  ambient tests that now pass `{ enabled: true }`.

## 2026-08-18 - Anchor restart records at branch state (issue #6981 review)

### What changed

- The persisted record is derived from the resident registry entry plus the sent-hashes the branch actually carries.
  The process binding map is no longer read at `message_end`: it holds the previous turn's state while that handler
  runs, and only a prefix digest right after a restart, so reading it anchored this turn's marker to a stale or absent
  sent-stream (duplicate resend after restart) or threw on the restored shape (orphaned marker, silent flatten on the
  next restart).
- The safe-suffix allowlist now admits the whole display-only metadata family the co-resident builtins append after a
  committed assistant: stop-hook state/diagnostics/output, rule activations, and rule scans. Previously a project with
  a Stop hook emitting diagnostics or output failed restore on every restart.
- Records are keyed and compared by canonical session path, so a symlinked directory or another spelling of the same
  file resolves to one sidecar instead of silently losing the binding.
- A non-`clean` commit outcome no longer anchors a record, an orphaned record whose session id does not match is
  deleted rather than left on disk, and the pending-fork labels that lost their producers are gone.
- `session_before_fork` no longer records a taint: forks mint a new session id and file, so the taint was unreachable;
  `session_start(fork)` invalidation plus path/session binding is what isolates a fork.

### Declared residuals

- Branch-derived hashes decline to anchor when a compaction boundary sits on the branch: the walk is not
  compaction-aware while admission compares against the compaction-truncated context, so anchoring across a boundary
  would inflate `sentCount` and flatten every later restart. Declining leaves restart resume unavailable for that
  session instead of silently wrong. Not reachable while this lane is active (the lane stands senpi compaction down),
  so it needs a compaction entry from another provider's turns, a legacy version, or an imported file.
- `isContentlessUserMessage` matches only a literal zero-length array, while the context path normalizes a null or
  missing `content` to an empty array before filtering. A legacy, imported, or hand-edited message with a null
  `content` therefore diverges between the two derivations. It fails closed (cold-seed), and it is the same untrusted
  input class the trust boundary covers.
- `verifyRestoredTranscript` requires the stored assistant boundary to exist in the transcript, not to be its tip.
- A `custom_message` or `branch_summary` entry shifts the same way: the context path converts both to a user message
  and hashes them, while the branch walk skips them because they persist as their own entry types rather than as
  `message`. The branch therefore under-counts, never over-counts, so a restart either flattens (divergence inside the
  anchored prefix) or re-sends the later messages as delta (divergence after it). The cost is a lost cache, not a
  wrong resume, and unlike the compaction residual it self-corrects rather than persisting.

### Trust boundary

- The session JSONL is untrusted input (it can be imported, hand-edited, or copied) and carries only a capability-free
  marker. The sidecar is the trusted store: mode 0600, strict schema, bounded size, keyed to one canonical session
  path and session id. Integrity rests on same-user file ownership, the same boundary as the SDK's own config dir.

### Cost

- Each committed assistant appends one small marker entry to the session file and rewrites the fixed-size sidecar, so
  session files grow by one marker per assistant message (several per tool-loop turn) while the record itself stays
  constant-size regardless of conversation length.

## 2026-08-18 - Persist restart bindings for headless continuation (issue #6981)

### What changed

- Successful resident turns append a capability-free branch marker and atomically replace a private, fixed-size
  sidecar containing the SDK lineage, sent-prefix digest, assistant hash/boundary, identity, and prompt/tool
  fingerprints.
- Startup/resume restores only when the sidecar belongs to the current session file and header, its exact marker and
  adjacent committed assistant remain on the active branch, and the local SDK transcript still contains the stored
  top-level assistant boundary. Imported JSONL and legacy custom payloads are never lineage authority.
- Provider exits, assistant rewrites, accepted compaction, forks, tree navigation, and extension removal delete
  durable and process state. Persisted identity drift and config-dir transcript roots fail closed; reload retains the
  fresher process binding, and nested binding state is copied at the registry boundary.

### Why

- `omo -p -c` restores the Senpi JSONL session in a new process, but the SDK registry and binding maps are module
  memory. The existing checkpoint parser was never wired into runtime append or restore, so every headless
  continuation started without a binding and re-sent the full conversation with `registry_miss`.

### Why an extension could not handle it

- The binding contains private SDK lineage and sent-stream hashes created inside this builtin provider. No external
  extension can reconstruct that state after the provider process exits.

### Expected merge-conflict zones

- MEDIUM in `session-binding.ts`, `session-binding-store.ts`, `session-registry-wiring.ts`,
  `session-continuity.ts`, `session-reattach.ts`, and `session-stream.ts`; LOW in their focused tests and issue #6981
  regression.

## 2026-08-18 - Select the Claude binary for the host libc

### What changed

- Linux executable resolution now tries the glibc package first on glibc hosts and when libc detection is unavailable, and tries the musl package first only when `process.report` identifies musl.
- The libc detector is injectable for deterministic coverage, while the non-preferred Linux package remains a fallback and `CLAUDE_CODE_EXECUTABLE` remains the highest-priority override.

### Why

- The resolver previously selected the musl package first on every Linux host. When both optional packages were installed on glibc, the chosen binary exited with code 127 because `/lib/ld-musl-*` was unavailable.

### Why an extension could not handle it

- The executable path is resolved inside this builtin provider before SDK query construction and ambient authentication probes; no external extension hook can replace that private boundary.

### Expected merge conflict zones

- LOW: `executable.ts` around Linux candidate ordering and default dependency detection.

## Repository audit baseline for the claude-sdk-oauth tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). The audited production paths whose exact nearest tracker is this file:
  none — every file under `packages/coding-agent/src/core/extensions/builtin/claude-sdk-oauth/` is fork-only (absent
  from the pinned upstream tree), so the audit assigns this tracker no upstream-owned divergence.
- Two leftover diff3 conflict-separator lines were removed from the historical entries below; the surrounding
  history is preserved unchanged.

### Why

- Anchoring the tracker in canonical four-section form keeps future divergences under this directory resolvable by
  the audit gate, and stray conflict markers would corrupt any future structural pass over the history.

### Why an extension could not handle it

- Tracker coverage is repository and release policy, not runtime behavior; it is enforced by repository scripts before
  any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker is fork-only (upstream has no counterpart file).

## 2026-08-14 - Preserve effective ambient request authentication

### What changed

- Ambient resolution now returns the effective `CLAUDE_CODE_OAUTH_TOKEN` slot environment with its sentinel auth result.
- Both resident and non-resident SDK lanes pass only Claude OAuth request slots into account discovery and subprocess environment construction.
- A request token namespace replaces host token slots instead of joining them, and unrelated request values such as `PATH`, `HOME`, or `NODE_OPTIONS` cannot cross the SDK child boundary.
- Present-but-empty request token slots remain in the effective environment returned with the synthetic auth marker, so replay cannot substitute a host token.
- Ambient resolution receives the raw request environment and applies Claude token slots as one namespace. Masking the primary slot therefore cannot import a host secondary slot, and masking a numbered slot cannot import the host primary slot.
- A request token configured with `tokenInjection: "config-dir"` is routed through the non-persisting OAuth environment lane instead of being written into the stable agent credential directory.
- Explicit ambient injection treats request token slots as configured without probing host Claude login state.
- Availability probes reject pre-aborted cold callers, keep one in-flight owner across TTL boundaries, and timestamp only settled cache results.
- Focused coverage drives request tokens through stored/ambient auth, true ambient and resident lanes, real session-title generation, and captured SDK subprocess options while a different host token is present.

### Why

- Request-scoped environment overrides were accepted during availability resolution but discarded before SDK spawn, widened to unrelated process-control values, persisted under `config-dir`, or merged per variable so a different host token slot survived an explicit mask. Empty masks were also dropped before replay. The child could inherit or fail over to a host account, cross account and billing boundaries, persist a request secret, or accept request-controlled Node startup configuration.
- A pre-aborted caller could start and populate a shared probe, while a long-running probe could be duplicated once its future cache TTL elapsed.

### Why an extension could not handle it

- The effective credential crosses the builtin provider's private auth resolver, resident-session adapter, availability cache, and SDK subprocess boundary. No external hook can restore or safely narrow it after those boundaries.

### Expected merge-conflict zones

- MEDIUM: `oauth-login.ts` around ambient resolution, `auth-lane.ts` plus `auth-environment.ts` around environment/account discovery, `config-dir-credentials.ts` around persistent managed-account materialization, and `availability.ts` around in-flight/cache ownership.
- LOW: `stream.ts` and `session-stream.ts` where request options enter the auth lane.

## 2026-08-14 - Pin native auto-compaction on the SDK lane

### What changed

- Every Claude SDK OAuth query now supplies session-scoped inline settings with `autoCompactEnabled: true`.
- The lane deliberately leaves `autoCompactWindow` unset and keeps the SDK's supported window behavior.
- Focused options coverage pins the setting even when the provider configuration has no compaction preference.

### Why

- The ambient lane can load the user's Claude Code settings, including `autoCompactEnabled: false`. Senpi stands down its
  own compaction while a resident SDK query owns the conversation, so inheriting that preference could leave no
  compaction owner at all.
- The SDK's inline `settings` option is loaded into the highest-priority user-controlled flag-settings layer, making the
  lane contract override filesystem preferences for this query without changing the user's global configuration.

### Why an extension could not handle it

- Query options are assembled inside this builtin provider before the Claude Code subprocess starts. External extensions
  cannot inject SDK flag settings at that private spawn boundary.

### Expected merge-conflict zones

- LOW: `options.ts` at the query-options literal and its focused options test; LOW in the provider documentation.

## 2026-08-14 - Ignore rejected compaction events for resident continuity

### What changed

- The session registry wiring now records a pending compaction fork only when `session_compact.accepted` is true.
- Focused lifecycle coverage pins accepted, rejected, missing, and undefined `accepted` values so malformed event shapes fail closed.

### Why

- Core emits `session_compact` with `accepted: false` when compaction is rejected. The previous handler treated that
  notification as a completed transcript rewrite, tainting an unchanged resident SDK session and forcing an
  unnecessary cache-destroying transcript flatten on the next turn.

### Why an extension could not handle it

- The incorrect pending-fork mutation occurs inside this builtin provider's private resident session registry.
  External extensions cannot undo that continuity state once recorded.

### Expected merge-conflict zones

- LOW: `session-registry-wiring.ts` at the `session_compact` handler and its focused wiring test.


## 2026-08-14 - Hide ambient auth probes on Windows

### What changed

- `readAmbientClaudeAuthStatus()` now passes `windowsHide: true` when spawning
  `claude auth status`, preventing the availability check from opening a console
  window on Windows.
- Merged with the bounded ambient probe: `windowsHide` moved onto the default
  `spawnProbe`, so the injected-spawn path and the real spawn stay identical.
- `claude-sdk-oauth-availability.test.ts` drives the two outcome cases through
  `probeAmbientClaudeAuthStatus` instead of the reader, because the reader
  memoises for 30s and would replay the first probe's `true` to both.

### Expected merge-conflict zones

- LOW: `availability.ts` spawn options.

## 2026-08-13 - Preserve request cancellation through OAuth refresh

### What changed

- Managed account refresh now receives the active turn's `AbortSignal` through both non-resident and resident
  query paths, instead of constructing a detached signal inside the Anthropic OAuth adapter.
- Direct provider login uses the shared `ProviderAuthInteraction` contract and supplies either the caller's
  signal or a concrete never-aborted fallback.
- Focused account, auth-lane, and login tests assert the exact signal identity reaching the refresh and login
  boundaries.

### Why

- Upstream made provider OAuth refresh and login cancellation mandatory. The merge initially satisfied the new
  type with locally constructed signals, which made an aborted turn unable to cancel credential refresh and
  could delay shutdown or failover behind unrelated network work.

### Why an extension could not handle it

- Credential refresh runs inside this builtin provider before the SDK subprocess is spawned. No external hook
  can replace that private auth-lane boundary or retroactively attach the turn's cancellation signal.

### Expected merge-conflict zones

- MEDIUM: `accounts.ts` and `auth-lane.ts` around `SlotRefresher`, `refreshSlot`, and `prepareSlot`.
- LOW: `stream.ts`, `session-stream.ts`, and `oauth-login.ts` at request-to-auth signal plumbing.

## 2026-08-12 - Account-aware default auth lane (issue #6784)

### What changed

- `auth-lane.ts` `managedPool` no longer defaults `tokenInjection` to `ambient`. A new exported `resolveEffectiveLane(settings, accounts)` resolves the lane as `settings.tokenInjection ?? (accounts.length > 0 ? "oauth-slots" : "ambient")`.
- `oauth-login.ts` `createOAuthConfig` gains an optional `readSettings` dep so the OAuth `check` resolves the same effective lane. On a managed lane it reports configured only when accounts exist; on ambient it defers to the ambient Claude CLI probe.
- `index.ts` wires `readSettings` to `loadClaudeSdkOauthProviderSettingsFromDisk(process.cwd())`.
- `options.ts` `buildClaudeSdkOauthQueryOptions` aligns its `authLane` fallback to `ambient` so both lane-resolution sites agree (the previous `?? "oauth-slots"` was a dead default contradicted by `managedPool`).

### Why

Commit `606aa052b` (2026-07-27) flipped `managedPool`'s default from `oauth-slots` to `ambient` as a review-time safety hold ("until the live spike proves a managed lane"). The managed lanes matured across the 2026-08-01 and 2026-08-11 waves, but the default was never restored, so OAuth accounts saved by senpi's own login into `~/.omo/auth.json` were NEVER injected into the spawned Claude Code subprocess unless the user explicitly set `claudeSdkOauthProvider.tokenInjection`. On a machine where `claude auth status` is logged out, every query (main turn and `session_title_generation`) failed with "Failed to authenticate: OAuth session expired and could not be refreshed" (oh-my-openagent#6784).

The ambient lane remains the default ONLY when no accounts exist, preserving the zero-config Claude Code CLI-login path documented in the 2026-08-11 entry. An explicit `tokenInjection` setting always wins.

### Why an extension could not handle it

The lane decision lives inside the builtin provider's own `queryWithAuthLane`/`managedPool` and the OAuth availability `check`, both of which no external extension hook can replace.

### Expected merge-conflict zones

LOW in `auth-lane.ts` (new `resolveEffectiveLane` + `managedPool` lane resolution); LOW in `oauth-login.ts` (`readSettings` dep + lane-aware `check`); LOW in `index.ts` (one new import + `readSettings` wiring); LOW in `options.ts` (one fallback literal). LOW in `test/claude-sdk-oauth-auth-status.test.ts` and `test/suite/regressions/6784-claude-sdk-oauth-default-lane.test.ts`.

## 2026-08-13 - Bound the ambient probe and let an abandoned request stop waiting

### What changed

- `probeAmbientClaudeAuthStatus` runs under a 10s deadline, killing the status child and reporting unavailable
  when it expires. The probe accepts an injected spawn so the deadline is covered without a real subprocess.
- The reader returned by `createAmbientAuthStatusReader` takes an optional `AbortSignal` and rejects for THAT
  caller once its request is abandoned. The shared probe keeps running for the callers still waiting on it.
- `check()` and `resolveAmbient()` thread the signal supplied by `ApiKeyAuth`, so both paths through
  `configuredFor()` are bounded.

### Why

- `claude auth status` validates credentials and can stall. The probe sits on the auth path of every request and
  its result is shared, so one stall parked every caller that joined it, with no deadline and no way for an
  aborted turn to walk away. Model calls waited behind auth resolution that could never settle.
- Cancelling the shared probe on one caller's abort would be the wrong repair: it would cancel work another live
  request is waiting on. Only the individual wait is abandoned.

### Why an extension could not handle it

- The probe and its cache live inside this builtin provider, behind `Models.getAuth()`. No external hook observes
  that boundary or the per-request signal reaching it.

### Expected merge-conflict zones

- LOW: `availability.ts` around the reader and probe signatures.
- LOW: `oauth-login.ts` at `configuredFor`, `check`, and `resolveAmbient` parameter lists.

## 2026-08-12 - Restore request auth for the ambient lane

- Regression from 2acbb6e0c ("Require a real OAuth login for runtime availability"), which removed the
  `apiKey: "claude-sdk-oauth-managed"` registration placeholder. That placeholder was the provider's only route to
  api-key auth, and `resolveProviderAuth()` reads ambient credentials exclusively through `apiKey.resolve()`.
  Removing it left the provider registering `oauth` alone, so with no stored account every request failed
  `Provider is not configured: claude-sdk-oauth` — including the automatic `session_title_generation` call, which
  surfaced the error on session start before the user typed anything.
- The availability check kept accepting an environment token or a logged-in Claude CLI, so those users still had
  `claude-sdk-oauth` models offered and selected. Availability and resolution disagreed, and no configuration could
  fix it: only a stored credential was ever consulted, while `queryWithAuthLane` has always supported an `ambient`
  lane that `managedPool` selects by default.
- `createOAuthConfig` now exposes `resolveAmbient()`, returning the sentinel access field when the provider is
  usable without a stored credential. `check()` and `resolveAmbient()` share one `configuredFor()` predicate — the
  lane resolution introduced by the entry above, factored out — so availability and resolution cannot drift apart
  again. This does not restore the false availability 2acbb6e0c fixed: resolution applies the same lane rules and
  the same real probe as `check()`, where the removed literal reported configured unconditionally.
- `availability.ts` memoises the ambient probe (30s TTL, shared in-flight read, rejections uncached). The probe
  spawns the Claude binary at roughly 200-650ms and now sits on the per-request auth path rather than only on
  catalog refresh.
- This cannot be implemented by an external extension: the composer discards a provider's ambient credentials
  before `Models.getAuth()` runs, so the resolution path must exist in provider composition.
- Expected merge conflict zones: LOW in `oauth-login.ts` and `availability.ts`; LOW in the focused ambient
  resolution and probe-cache tests.

## 2026-08-11 - Require a real OAuth login for runtime availability

- Removed the literal `apiKey: "claude-sdk-oauth-managed"` registration placeholder. Provider composition treated
  that sentinel as configured API-key authentication, so a machine with no Claude SDK OAuth account still admitted
  `claude-sdk-oauth` models into retry fallback selection before the subprocess returned `Not logged in`.
- Added a provider OAuth availability check that accepts a stored account, any `CLAUDE_CODE_OAUTH_TOKEN` slot, or a
  successful `claude auth status` exit code. Empty and persisted `accounts: []` credentials remain unavailable.
- The ambient probe resolves the same bundled/overridden Claude executable used by requests, discards its output, and
  decides only from the documented exit status, so account identity and credentials never enter logs.
- Errored fallback responses (e.g. `Not logged in`) are rejected as fallback successes both within the active turn
  and on the next turn's retry state, so a green `Fallback model responded` notice cannot surface from a provider
  that was never actually usable ([#803](https://github.com/code-yeongyu/senpi/pull/803)).
- Kept OAuth registration, catalog discovery, login selection, and SDK streaming unchanged for every usable auth lane.
- This cannot be implemented by an external extension: the false availability was created by this builtin provider's
  own auth metadata and must be resolved before retry fallback evaluates candidates.
- Supersedes [#804](https://github.com/code-yeongyu/senpi/pull/804), which introduced the initial account-aware
  availability check for managed lanes.
- Expected merge conflict zones: LOW in `index.ts`, `oauth-login.ts`, and `availability.ts`; LOW in the focused auth
  status and extension registration tests.

## 2026-08-11 - Account-aware auth availability for fallback

### What changed

`createOAuthConfig` (`oauth-login.ts`) now supplies an OAuth `check`, and `index.ts` passes a `readSettings` dep so that check can read the configured `tokenInjection` lane. `ExtensionOAuthConfig` (`provider-composer.ts`) gained an optional `check` that `adaptOAuth` forwards to the composed `OAuthAuth`. The provider still registers the `claude-sdk-oauth-managed` api-key sentinel, which keeps the ambient default configured (see below); only the stored-OAuth-credential path becomes account-aware.

### Why

The fallback engine never skipped this provider as `unauthenticated`. A stored `emptyCredential()` is `{ type: "oauth", ...SENTINEL_OAUTH_FIELDS, accounts: [] }`, and the upstream stored-OAuth branch in `ModelsImpl.checkProviderAuth` reported configured for any OAuth credential without inspecting `accounts`, so a zero-account sentinel still counted as logged in. The new `check` returns configured only when `listAccounts` finds at least one account (stored login/import or a `CLAUDE_CODE_OAUTH_TOKEN` env slot); on a managed lane (`oauth-slots`/`config-dir`) with zero accounts it returns unconfigured so the candidate is skipped. The ambient lane stays configured with zero accounts because the spawned Claude Code engine may hold its own login that senpi cannot see — that deferral is intentional (`auth-lane.ts`, `docs/providers.md`).

### Why an extension could not handle it

The stored-OAuth branch in `ModelsImpl.checkProviderAuth` is a structural short-circuit with no extension hook, and `OAuthAuth` had no `check` field (unlike `ApiKeyAuth`). `Provider.filterModels` filters the catalog in `getAvailable()` but cannot influence `configuredProviders` / `hasConfiguredAuth`, which the fallback controller reads. So the availability decision required the upstream `OAuthAuth.check` added in the companion `packages/ai` change; this extension only supplies the account-aware implementation.

### Expected merge-conflict zones

LOW in `oauth-login.ts` (added `check` to the returned shape + optional `readSettings` dep); LOW in `index.ts` (one added `readSettings` line); LOW in `provider-composer.ts` (`ExtensionOAuthConfig.check` + `adaptOAuth` forwarding, both additive).


## 2026-08-10 - Ignore content-less user messages in sent-stream continuity

- `sentMessages()` now drops user messages whose `content` array is empty. Such a message carries nothing to transmit
  and is transient: it is present for a single provider call and gone by the next. Hashing one shifted every later
  index, so the following turn reported `sent_stream_diverged` and re-sent the entire history even though the
  conversation had not changed.
- Observed live on `2026.8.9-2`: consecutive prefix snapshots of one session held 203 messages both times, with the
  only difference an empty user message at index 201 that vanished on the next call, forcing a 203-message flatten.
- Tool results are never filtered. An empty tool result is a real observation, and its `toolCallId` and `toolName`
  stay hash-significant, so genuine rewrites of already-sent history still resolve to `sent_stream_diverged`.
- This cannot be implemented by an external extension: the transmitted set is computed inside the builtin provider
  before session-registry continuity is decided, and no extension hook can replace it.
- Added `test/suite/regressions/790-claude-sdk-oauth-empty-user-continuity.test.ts` covering the transient empty
  message, a plain append, a genuine rewrite, and the filter itself.
- Expected merge conflict zones: LOW in `session-sync.ts` (`sentMessages`); LOW in the new regression test.

## 2026-08-07 - Ignore volatile thinking timing in continuity hashes

- Removed `startedAt` and `endedAt` from thinking blocks before hashing the provider-final and committed assistant
  messages. Agent-core adds those display-only fields after the final `message_update`, so hashing them falsely marked
  otherwise identical turns as `assistant_rewritten` and forced full-history replay on the next turn.
- This cannot be implemented by an external extension: the comparison happens inside the builtin provider's private
  commit boundary before session-registry continuity is decided, and no extension hook can replace that digest.
- Kept thinking text, signatures, and every non-thinking block in the hash so real assistant rewrites still trigger
  continuity divergence handling.
- Added a deterministic issue #691 regression covering both the timing-only and semantic-change cases.
- Expected merge conflict zones: LOW in `session-commit-boundary.ts`; LOW in
  `test/suite/regressions/691-claude-sdk-oauth-thinking-timing.test.ts`.

## 2026-08-04 - Surface flatten payload size and collapsed directive count in continuity observations

- Extended `ContinuityObservation` (`session-observability.ts`) with optional `payloadBytes` and `collapsedDirectives` fields, surfaced only on `flatten` and `bootstrap` observations (not delta/fork/reattach).
- Threaded from `createResidentAttempt` (`session-stream.ts`): the dedupe result's `collapsedDirectives` and the serialized block byte total are passed to `observeSessionSyncDecision` when the lane flattens, so users can see the re-send cost and how many directive blocks were collapsed.
- Updated diagnostic-render and observability tests to use `expect.objectContaining` for flatten/bootstrap observations (the shape intentionally grew).
- Merge-conflict risk: low. Expected conflict zones are `session-observability.ts` (ContinuityObservation type + observeSessionSyncDecision) and `session-stream.ts` (createResidentAttempt observation call).

## 2026-08-04 - Collapse repeated ultrawork directive blocks in flatten serialization

- Added `dedupeUltraworkBlocks` (`prompt-directive-dedupe.ts`), a pure post-process over `buildPromptBlocks` output that collapses repeated `<ultrawork-mode>...</ultrawork-mode>` directive spans to the single most recent copy, replacing earlier copies with a one-line placeholder. Wired into both flatten call sites: the resident lane (`session-stream.ts` `createResidentAttempt`, the primary burner path) and the non-resident lane (`stream.ts`).
- Why: when continuity diverges (compaction, abort, model switch, restart, account failover) the lane flattens the full transcript into one prompt. The omo ultrawork hook re-injects the ~17KB directive on every trigger-matching input with only an input-scoped guard, so copies accumulated and were re-sent verbatim on every flatten — issue #494's 875KB prompt was 73% such duplicates.
- Hash safety: `dedupeUltraworkBlocks` operates only on the serialized output and never mutates `context.messages`, so continuity hashes (derived in `session-sync.ts`) are unaffected. Spans match within a single text block only; a lone open tag in one block and a close tag in another never form a span.
- Why an extension could not handle it: the dedupe must run inside the flatten serialization in `createResidentAttempt` / `stream.ts`, which no extension hook reaches.
- Merge-conflict risk: low. Expected conflict zones are the `buildPromptBlocks` call sites in `stream.ts` and `session-stream.ts` and the new `prompt-directive-dedupe.ts` import.

## 2026-08-01 - Resume-first session continuity (SDK ledger is authoritative)

- **One SDK session lineage per senpi conversation.** A new `query()` is no longer a new session: every query replacement re-attaches with `resume: <sdkSessionId>`, so normal turns, model switches, thinking-level switches, ESC aborts, idle expiry, and shared-root account failover all continue the same lineage. Flattening the transcript into a `<conversation_history>` envelope is demoted to a last resort, reachable only when the SDK transcript is genuinely unusable.
- **Why this mattered.** A full-stack probe against the previous code showed a plain 6-turn conversation already reused one session (`queries=1 lineages=1 flatten_turns=0`). The reported cache-hit decay therefore came from divergence boundaries — compaction, abort, model switch, restart, midnight fingerprint churn, failover — which a long conversation hits constantly, each one re-sending the entire history. Those boundaries are what this change removes.
- **Decision table.** `decideNativeContinuity` (session-continuity.ts) replaces the retired `decideSessionSync` and resolves every admission to `delta` | `reattach` | `fork` | `flatten` | `bootstrap`. `flatten` is reserved for a missing transcript or an unusable binding; a live session is never abandoned for a flattened re-send. The fork point is the last assistant boundary STRICTLY BEFORE the divergence, because forking at the diverged turn would carry the stale assistant into the new branch and leave nothing to re-send.
- **SDK ledger authority.** Assistant-provenance staging is deleted. Divergence is decided at a `message_end` commit boundary (session-commit-boundary.ts) comparing what the provider streamed against what the ledger committed. The previous in-flight staging reported false divergence on result-only turns — a supported SDK response shape — which tainted the session and cold-seeded the next turn.
- **Option intake.** Non-fork reattach passes `resume` and MUST omit `sessionId`; the SDK rejects that pair (sdk.d.ts:1805-1808) and would otherwise start an unrelated session. Fork adds `resumeSessionAt` + `forkSession`.
- **Abort.** `interrupt()` receipts gate the outcome: `still_queued: []` keeps the live session; a legacy or uncertain receipt closes the query but keeps the binding for reattach. Abort never taints and never flattens. Teardown during resume-initialization is synchronous, so an aborted initialization is torn down before the next assertion point.
- **Fingerprint.** The generated `Current date:` line is normalized before hashing, so a UTC midnight rollover no longer retires a live conversation; cwd and every other prompt region stay fail-closed. Host tool policy is fingerprinted by an explicit `HOST_TOOL_POLICY_FINGERPRINT` version instead of callback source text, and the executable path plus `includePartialMessages` now participate.
- **Account failover.** Shared-root lanes (`oauth-slots`, `ambient`) reattach, or fork at the last verified boundary when cross-account resume is denied. The `config-dir` lane keeps per-account credentials inside its own `CLAUDE_CONFIG_DIR` and no official SDK API moves a transcript across roots, so its failover is the one declared residual that still flattens.
- **Restart.** A bounded branch-local checkpoint records the SDK lineage, sent-prefix digest, last assistant boundary, account/model identity, and prompt/tool fingerprints. Startup/resume restores it only when the checkpoint is followed by its committed assistant and the current prefix digest matches; malformed, invalidated, divergent, or unavailable SDK state falls back without guessing a fork boundary.
- **Observability.** Every main turn emits exactly one continuity observation (kind + sanitized reason + delta count) as an assistant diagnostic and a structured `claude_sdk_oauth_session_continuity` `session.log` event (paired with `claude_sdk_oauth_session_close`); the TUI shows a muted notice only for degradations. `closeSession` no longer discards its reason — the retained cause is attributed to the next admission.
- **Escape hatch.** `resumeMode: "off"` (or `SENPI_CLAUDE_SDK_OAUTH_RESUME=off`) still restores the legacy per-turn behaviour and reports `disabled` observations.
- Merge-conflict risk: high across this directory. New modules: session-continuity.ts, session-reattach.ts, session-binding.ts, session-commit-boundary.ts, session-observability.ts, session-reaper.ts, session-entry-annotations.ts.

## 2026-08-01 - Subscription-limit failover classification

### What changed

- Claude subscription-limit responses are classified as account-failover conditions rather than terminal provider errors.

### Why

- Multi-account OAuth sessions should move to an available account when one subscription lane is exhausted.

### Why this cannot be expressed externally

- Classification feeds the built-in auth lane, account affinity, and stream-safe retry state.

### Expected merge conflict zones

- `auth-lane.ts`, provider error classification, and account failover tests.

## 2026-07-31 - Native system prompt, session reuse, env overrides, and transcript hardening

- **System prompt modes (new default: `full`).** Added a `systemPromptMode` setting with three values. `full` (new default) sends senpi's own composed system prompt verbatim — previously the lane rebuilt a prompt from the SDK `claude_code` preset plus three extracted regions, so any region without a dedicated extractor was silently dropped (a persistent response-language instruction never reached the model). `preset-append` is the previous behaviour, now DEPRECATED and kept for one release; selecting it emits a one-time warning. `override` loads the system prompt verbatim from a file (`systemPromptFile`). The legacy `appendSystemPrompt` key still works and maps onto the modes: `false` → `preset-append`, `true`/unset → `full`. Setting both `appendSystemPrompt` and `systemPromptMode` makes `systemPromptMode` win and emits a warning.
- `full` and `override` default `settingSources` to `[]` on every lane, because senpi's prompt already carries project context and loading the SDK's own CLAUDE.md would double-inject it.
- Honest limitation: the CLI always prepends its own `"You are a Claude agent, built on Anthropic's Claude Agent SDK."` block, which senpi cannot suppress. `full` means senpi's prompt is delivered intact, not that it is the only text in the system prompt.
- **No prompt-cache benefit from array splitting.** An earlier draft split the prompt into a `string[]` around a `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` sentinel to keep the stable prefix cacheable. A wire-level probe against the installed CLI (`cc_version=2.1.220.04c`) proved the CLI joins all array elements into a single system block and never honours the sentinel, so the marker reached the model as literal text. The marker has been removed. Per-element cache scoping is not supported by the current CLI.
- **Environment overrides.** Six variables, precedence `env > project settings > global settings > default`. No new CLI flags: `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_MODE`, `SENPI_CLAUDE_SDK_OAUTH_SYSTEM_PROMPT_FILE`, `SENPI_CLAUDE_SDK_OAUTH_RESUME`, `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION`, `SENPI_CLAUDE_SDK_OAUTH_SETTING_SOURCES`, `SENPI_CLAUDE_SDK_OAUTH_PINNED_ACCOUNT`. Every `SENPI_*` variable is now stripped from the Claude Code subprocess environment on all three lanes (oauth-slots, config-dir, ambient); other inherited variables are preserved.
- **Session reuse.** One long-lived SDK query per senpi session instead of a fresh one per turn, so a conversation continues instead of cold-starting each turn and only the new delta is sent. Always fails closed to a fresh session when the conversation diverges: compaction, branch/fork navigation, account failover, an aborted turn, or a configuration change. Idle sessions are retired after 30 minutes and at most 32 sessions stay resident; a session with a turn in flight is never evicted. After a senpi process restart the lane always starts a fresh SDK session rather than trying to re-attach. `resumeMode` accepts `"auto"` (default) and `"off"`; set `resumeMode: "off"` (or `SENPI_CLAUDE_SDK_OAUTH_RESUME=off`) to restore the old per-turn behaviour. Any other value is silently ignored (falls back to `"auto"`).
- **Fallback transcript hardening.** When a full re-send is unavoidable, the flattened history is wrapped in a `<conversation_history>` envelope with an explicit anchor instruction and the real user message placed last and unlabelled. Previously the flat `USER:`/`ASSISTANT:` transcript read as a continuable document and baited the model into fabricating its own turns.
- Merge-conflict risk: low. The only overlap surface is the settings/env-resolution block in `buildClaudeSdkOauthQueryOptions`, which the concurrent `stream.ts` / `auth-lane.ts` work also touches.

## 2026-07-31 - Rename the internal provider identity

- Renamed the builtin path, provider/model ID, storage sentinels, account directory, settings key, TypeScript symbols, commands, tests, and QA scenarios from `claude-agent-sdk` to `claude-sdk-oauth`.
- Kept the external dependency and executable packages named `@anthropic-ai/claude-agent-sdk`; only Senpi-owned identity changed.
- Split stream coverage into prompt-bridge and stream-event suites so every edited test file remains below the 250-pure-LOC ceiling.
- Existing persisted entries under the old provider/settings/account-directory names are intentionally not aliased; backward compatibility was not requested for this explicit identity replacement.
- Merge-conflict risk: high across this directory and its provider-focused tests; PRs touching the old path must be integrated before merge.

## 2026-07-30 - Forward the bounded project rules region into the SDK append

- Added `extractProjectRulesAppend()` and wired it as the third `append` entry, after AGENTS.md and skills.
- Why: this lane never sends senpi's composed system prompt. It rebuilds one from the `claude_code` preset plus `append`, so any region without a dedicated extractor is discarded. Every project rule source (`.omo/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`) silently failed to reach the model, while AGENTS.md kept working only because `extractAgentsAppend` re-reads it from disk.
- The region is located by the rules builtin's opaque region sentinels, not by the model-facing `<project_rules>` tags: prompt content this lane does not own (context files before the block, extensions appending after it) may legitimately contain those tags and would otherwise be extracted as project rules. Rule content quoting either the sentinels or the tags is neutralized producer-side.
- The sentinels are a reserved wire literal, but nothing neutralizes them in content the rules builtin does not produce, so every sentinel candidate is structurally validated (it must open with the `<project_rules>` tag followed by the `## Project Instructions` heading and close with the tag) and rejected candidates are skipped. Without that, an `AGENTS.md` carrying a sentinel would either shadow the real block or cross-match its end sentinel and hand the model unrelated text as project rules. Replicating a complete, well-formed frame is out of scope — that is a trusted-extension boundary, not a parsing one.
- Extraction is fail-closed: a region missing its end sentinel is skipped rather than read to end-of-string, so sections appended by extensions registered after `rules` (`mcp`) are never relabelled as project rules. The forwarded append carries the `<project_rules>` envelope; the sentinels themselves are stripped.
- Why an extension could not handle it: the `append` list is assembled inside `buildClaudeSdkOauthQueryOptions`, which no extension hook can reach.
- Scope note: the other `before_agent_start` system-prompt mutations dropped by this lane (`hooks`, `compaction`, `mcp`, `terminal`, `todotools`, web search) and the project `CLAUDE.md` / parent context files are unchanged here and remain open.
- Merge-conflict risk: low. Expected conflict zones are the `append` array literal in `buildClaudeSdkOauthQueryOptions` and the extractor cluster next to `extractSkillsAppend`.

## 2026-07-30 - Terminal pre-execution denial for host-captured tools (#494)

- Added an SDK `PreToolUse` hook for the six native Claude Code tools and `mcp__custom-tools__*`.
- The hook denies before Claude Code permission handling or safe-command execution and terminates SDK processing via top-level `continue: false` alongside its terminal do-not-retry instruction.
- Senpi still captures the streamed tool call and executes it through its own validation, hook, and permission pipeline.
- Merge-conflict risk: low. Expected conflict zones are the query options and tool denial constants.

## 2026-07-27 - Initial builtin provider

- New builtin extension: Claude SDK OAuth provider with native multi-account OAuth, HRW session
  affinity, mandatory stream-safe failover, `/claude-account` + `--claude-account`, RPC/app-server
  account events, and auth guidance. See `packages/coding-agent/docs/providers.md` (Claude SDK OAuth)
  and `.omo/plans/claude-sdk-oauth-provider.md`.
