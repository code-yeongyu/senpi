# Builtin extensions changes

## Preserve explicit fast variants at session start (2026-09-05)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/service-tier.ts`: when session startup receives a compatible `-fast` catalog variant, it still swaps to the base model but preserves the selected thinking level with a session-scoped setter and keeps fast mode enabled. Remembered tier derivation remains unchanged for non-`-fast` starts.

### Why

- Selecting a `-fast` model at startup previously lost both the requested thinking level and the priority service tier when the extension normalized the variant to its base model.

### Why an extension could not handle it

- The startup model normalization and session fast-mode state are owned by this built-in extension's `session_start` handler.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/service-tier.ts` and its focused regression tests.

## Recommend GPT-6 Astra ahead of GPT-5.6 Sol (2026-09-05)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/recommended-models/index.ts`: insert `["gpt-6-astra", "high"]` immediately before `["gpt-5.6-sol", "medium"]` in `RECOMMENDED_DEFAULT_MODELS`. Astra is the new OpenAI flagship recommendation; Sol stays as the fallback. `canonicalModelId` is unchanged, so `gpt-6-astra-fast` still strips to `gpt-6-astra`.

### Why

- Sessions that land on an implicit OpenAI default should prefer GPT-6 Astra at thinking level `high` when `openai-codex/gpt-6-astra` (or a `-fast` variant) is authenticated, instead of stopping at GPT-5.6 Sol/`medium`. `packages/coding-agent/src/core/extensions/builtin/recommended-models/index.ts` is the shipped priority list for that auto-switch.

### Why an extension could not handle it

- The shipped default lives in `packages/coding-agent/src/core/extensions/builtin/recommended-models/index.ts`. A user extension or `settings.recommendedModels` override can change one machine, not the binary default every session gets without an override.

### Expected merge conflict zones

- LOW in `packages/coding-agent/src/core/extensions/builtin/recommended-models/index.ts` around `RECOMMENDED_DEFAULT_MODELS`. Keep `["gpt-6-astra", "high"]` immediately before `["gpt-5.6-sol", "medium"]`; do not reorder the other entries.

## Hooks trust-state reads fail open when the lock directory is not writable (2026-09-04)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/hooks/trust-storage.ts`: `FileHookStateStorage.read()` still
  parses the on-disk snapshot lock-free. When that parse is empty or malformed and lock acquisition then fails with
  `EPERM`, `EACCES`, or `EROFS`, the reader now returns the same fail-open empty state already used for `ELOCKED`.
  `update()` is unchanged and still throws on permission errors.

### Why

- Sandboxed or read-only children (macOS seatbelt `deny file-write*`, bwrap `--ro-bind`, a read-only HOME) cannot
  mkdir the `hooks-state.json.lock` directory. That error used to propagate out of the tool_call hook and fail every
  tool call. A reader that cannot take a lock must not break tool execution; writers must still fail closed.

### Why an extension could not handle it

- The hooks builtin owns this persistence path and calls `storage.read()` on session_start, input, tool_call, and
  tool_result before any user extension can intercept the failure.

### Expected merge conflict zones

- LOW in `packages/coding-agent/src/core/extensions/builtin/hooks/trust-storage.ts` around `FileHookStateStorage.read`'s
  lock-acquisition catch. Keep `EPERM`/`EACCES`/`EROFS` fail-open on read only; writers must still throw.

## Loop-owned exposure for `schedule_wakeup` (2026-09-04)

### What changed

- `loop/tools.ts`: `registerLoopTools` registers `schedule_wakeup` with `exposure: "search"` and
  `allowLazyActivation: false`, so the tool is absent from the default active list and from the
  `tool_search` catalog. `SCHEDULE_WAKEUP_DESCRIPTION` keeps the clamp, idle-range, prompt-cache and
  fallback-heartbeat guidance and drops the monitor/`bash_output`/`kill_bash`/`task` waiting rule;
  `tick-prompt.ts`'s dynamic rule is that rule's single home.
- `loop/index.ts`: `syncScheduleWakeupActivation()` derives the wanted state from scheduler state
  (some `dynamic` entry whose phase is neither `ended` nor `suspended`) and calls `pi.setActiveTools`
  only when the active list disagrees. It runs at the top of `refreshStatus()` (every command,
  timer, tool, restore, and settle transition already ends there) and again in `dispatchTick`
  before `sendUserMessage`, so the tool is active before the tick turn reads its tool list.
- Tests: `loop-wakeup-tool.test.ts` pins the exposure contract and the trimmed description;
  `loop-extension.test.ts` pins activation on dynamic start, one entry across the tick lifecycle,
  retirement on stop, no activation for fixed loops, and re-activation on session restore;
  `regressions/3592-no-builtin-tools-keeps-extension-tools.test.ts` no longer lists the tool as
  resident.

### Why

- The tool is meaningful only inside a dynamic loop (every other call is a typed error), yet it
  shipped 234 o200k tokens of description on every turn of every session. Search exposure with
  loop-owned activation removes that cost without changing the loop contract: the dynamic tick
  prompt still names a callable tool.
- Lazy activation is disabled because a `tool_search` hit outside a loop would only activate a
  tool that errors; explicit `setActiveTools` from the loop extension is the one legitimate path.

### Why an extension could not handle it

- `loop` is a builtin registered for every session; the activation decision needs the loop
  scheduler's own state transitions (create, tick, settle, stop, suspend, restore), which only
  `loop/index.ts` observes. No public event exposes those transitions to a sibling extension.

### Expected merge conflict zones

- LOW: `loop/index.ts` around `refreshStatus`/`dispatchTick` and the `./tools.ts` import;
  `loop/tools.ts` description + registration object. Upstream has no `/loop` extension, so the
  zone is fork-only.

## OpenAI Codex OAuth account command (2026-09-03)

### What changed

- `gpt-account.ts` (new): `/gpt-account` is the dedicated OpenAI Codex OAuth account manager, mirroring the
  `/claude-account` action set. `add` runs an interactive `openai-codex` oauth login through
  `ctx.modelRegistry.modelRuntime.login` and emits `emitProviderAccountsChanged` so subscribed clients re-read the pool;
  `remove <name>`, `pin <name>` and `unpin` go through `credential-accounts.ts` (which emits on its own); the
  no-argument form lists every stored slot as `name | source | available|blocked` with the pin marked. Only names,
  sources and health are rendered, never key or token material.
- `index.ts`: registers `{ id: "gpt-account", factory: gptAccountExtension }` immediately after the provider-neutral
  `account` builtin, so the Codex lane keeps its own command name the way `claude-sdk-oauth` and `cursor-cli-oauth` do.

### Why

- The provider-neutral `/account` command lists, pins, unpins and removes accounts for any provider but has no `add`, so
  the only way to put a second `openai-codex` account into the pool was `/login openai-codex` - the shared write path
  that this same pass fixes for LAB-109. Codex users need the add/remove/pin surface that claude-sdk-oauth users already
  have from `/claude-account`, and keeping it in its own command leaves the Codex-specific login wiring (interactive
  prompt relay, auth-url notices) out of the provider-neutral command.

### Why an extension could not handle it

- The command has to exist for every session, which means being present in the `builtinExtensions` registry in
  `index.ts`; a user extension cannot insert itself there. It also drives `modelRuntime.login` and the coding-agent auth
  storage pool directly, and that login/persist seam is core state with no extension-visible hook between producing a
  credential and writing it.

### Expected merge conflict zones

- LOW: the import block and the `builtinExtensions` array in `index.ts`, where every new provider lane adds a line.
  `gpt-account.ts` itself is new and fork-only.

## Shared eval-only routing predicate for prompt surfaces (2026-09-03)

### What changed

- `eval-only-routing.ts` (new): `isEvalOnlyRouting(pi)` returns whether the session registry holds an `eval` tool, which is the session's own condition for withholding `bash`, `powershell`, `workflow` and `monitor` from the model's direct tool list. `terminal/extension.ts` and `bash-timeout/index.ts` both consume it when rendering their system-prompt sections.

### Why

- Two builtins must render the same call form for the same tools, and each re-deriving the condition invites them to drift apart. One predicate keeps both surfaces on the session's actual arming rule, and keeps eval-less child agents (`explore`, `librarian`) on the direct forms they can really call.

### Why an extension could not handle it

- The consumers are builtins whose prompt sections are appended before the agent loop; a user extension cannot rewrite another builtin's section.

### Expected merge conflict zones

- LOW: the module is new and fork-only.

## Hooks trust-state snapshots publish atomically for same-account application state (2026-08-31)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/hooks/trust-storage.ts`: complete trust-state snapshots remain on a
  lock-free read path. After any malformed or empty read, the reader boundedly acquires the exact writer lock and
  re-reads while excluding writers. It returns a complete exclusive reread, returns fail-closed empty state when the
  exclusive reread is still malformed, and also fails closed without surfacing `ELOCKED` when a live writer outlasts
  the bounded acquisition window.
- `packages/coding-agent/src/core/extensions/builtin/hooks/trust-state-json.ts`: snapshot JSON parsing now reports
  completeness separately from the fail-closed empty state, allowing storage to retry only incomplete reads without
  changing trust parsing behavior.
- Serialized writers create a same-directory temporary snapshot, apply an ordinary same-account destination's numeric
  POSIX mode (or `0600` for a new file) with `chmod` after creation so process umask cannot mask it, and atomically
  publish it with rename. Hooks state is internal application state at `<agentDir>/hooks-state.json` or
  `<cwd>/.senpi/hooks-state.json`; externally reassigned ownership, supplementary-group ownership, named POSIX/macOS
  ACLs, and custom Windows DACLs are outside this storage contract.
- Failed publication removes the temporary snapshot. Operation failures remain unchanged when lock release succeeds,
  release-only failures propagate unchanged, and simultaneous failures become a flat causal `AggregateError`. Existing
  publication+cleanup entries precede the release failure.

### Why

- Concurrent session startup only reads hook trust state and must not fail because another process temporarily owns the
  writer lock. New writers publish by rename, but mixed-version deployments still include legacy writers that truncate
  the destination under the same lock before rewriting it. Sampling lock absence before and after an incomplete read is
  ABA-vulnerable: a legacy writer can acquire, truncate, publish, and unlock between both samples. Acquiring the writer
  lock after an incomplete read establishes a writer-excluding revalidation interval, making that ABA harmless without
  making complete reads contend. Applying the numeric mode after creation keeps ordinary same-account existing modes
  and the private new-file mode independent of process umask without claiming preservation of external security
  metadata.
- Cleanup and lock-release failures must not mask the operation that caused them. Flattened causal ordering preserves
  the actionable primary failure while retaining every later cleanup failure.
- Lock acquisition intentionally inherits proper-lockfile's `stale: 10_000` and `update: stale / 2` defaults. An
  actively refreshed lease gets ten bounded acquisition attempts and then fails closed on `ELOCKED`; stale recovery is
  proper-lockfile's inherited crash-recovery behavior. A writer suspended beyond that stale threshold has no stronger
  guarantee in this contract.

### Why an extension could not handle it

- The hooks builtin is the extension that owns this persistence implementation. Atomic filesystem publication, file
  modes, writer-lock coordination, and failure propagation occur inside its storage boundary before any hook event can
  run, so no separate extension hook can intercept or replace them safely.

### Expected merge conflict zones

- LOW in `packages/coding-agent/src/core/extensions/builtin/hooks/trust-storage.ts` around `FileHookStateStorage.read`
  and `FileHookStateStorage.update`, and in `trust-state-json.ts` around snapshot completeness parsing. Upstream edits to
  hook trust persistence should retain lock-free complete reads, writer-excluding bounded revalidation for incomplete
  reads, fail-closed `ELOCKED` exhaustion, same-directory atomic publication, ordinary same-account numeric-mode
  retention/default `0600`, the explicit exclusion of custom ownership/ACL/DACL preservation, and flat causal
  operation/cleanup/release errors.

## service-tier: clear the fast indicator when the session leaves the Codex family (2026-08-28)

### What changed

- `service-tier.ts` `model_select`: when session fast mode is on and the incoming model's `api` is not
  `openai-codex-responses`, the extension now drops its session flag and calls `pi.setSessionFastMode(false)`.
  Codex -> Codex switches are untouched, and the per-model `liveMemoryTier`/`liveMemoryKey` re-derivation that already
  ran on every switch is unchanged.

### Why

- `service_tier` is an OpenAI-family request field, so `before_provider_request` already refused to emit it after a hop
  to (for example) `anthropic/claude-opus-5`. The session flag, however, still fed `AgentSession.isFastModeActive()`,
  and through it the RPC `get_state.fastMode`, `effectiveServiceTier`, the `service_tier_changed` event, and the TUI
  lightning indicator - so the UI kept claiming fast for a model whose requests can never carry the tier. Fast mode
  stays a session intent across Codex models, and an incoming Codex model's remembered `"auto"` is still honored on the
  wire by `liveMemoryTier` rather than by clearing the display flag (clearing it there would also clear the session's
  inherited catalog `priority`, which `fast-mode-persistence.test.ts` pins as observable state).
- Coverage: `test/suite/regressions/stale-fast-mode-after-model-switch.test.ts` (Codex `/fast on` -> Anthropic
  `claude-opus-5` on a faux provider clears model/provider identity, `isFastModeActive()`, RPC `fastMode`,
  `effectiveServiceTier`, the last `service_tier_changed.fastMode`, and leaves the payload untouched; plus a control
  that a Codex sibling with no remembered preference keeps the indicator on).

### Why an extension could not handle it

- `service-tier` IS the builtin extension that owns the `/fast` session flag; the stale indicator originates in its own
  `model_select` handler, and only it knows whether the flag came from a session intent.

### Expected merge conflict zones

- LOW in `service-tier.ts` at the end of the `model_select` handler (one guard appended after the live-memory
  re-derivation); no other production file changes.

## Repository audit baseline for the builtin extensions tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). The audited production paths whose exact nearest tracker is this file:
  `packages/coding-agent/src/core/extensions/builtin/import-repro.ts` and
  `packages/coding-agent/src/core/extensions/builtin/redraws.ts` (both renamed out of upstream `.pi/extensions/`).
- Every other builtin extension and shared module in this directory is fork-only (absent from the pinned upstream
  tree) and exempt from the audit; their per-feature history lives in the dated entries below and in each extension's
  own `changes.md`.

### Why

- The audit requires every upstream-owned production divergence to be covered by one entry with all four canonical
  sections in its exact nearest tracker. The pre-existing entries below use flat bullets without canonical section
  headings, so both renamed paths were reported uncovered; this inventory closes that gap without rewriting accurate
  history.

### Why an extension could not handle it

- Tracker coverage is repository and release policy, not runtime behavior; it is enforced by repository scripts before
  any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker is fork-only (upstream has no counterpart file); the inventory names pin-relative paths so it
  stays valid as entries below change.

## /loop builtin extension registered (2026-08-18)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/index.ts`: one registration entry adds the fork-only `/loop`
  builtin extension (recurring and self-paced scheduled prompts, ported from Claude Code) to the builtin factory
  list. The extension itself lives entirely under `builtin/loop/**`; its design is documented in
  `builtin/loop/AGENTS.md`. Both paths are fork-only at pin `914cf1472e715297caa30db4b9535d534a9eb718` (upstream has
  no `builtin/` registry file or loop tree), so the audit exempts them; this entry records the registration
  divergence as feature history.

### Why

- The loop extension must be registered for every session like the other builtins (goal, todo, terminal), and the
  registration list in `builtin/index.ts` is the only file outside `builtin/loop/**` this feature touches.

### Why an extension could not handle it

- It is an extension; builtin registration is the one hook the extension cannot provide for itself, and
  `builtin/index.ts` is the only place builtins are wired into the loader.

### Expected merge conflict zones

- NONE: `builtin/index.ts` is fork-only (upstream has no counterpart file); the change is one import and one
  factory-list entry on adjacent lines.

## /tui redraw diagnostic relocated in-tree (2026-08-17)

### What changed

- `redraws.ts`: upstream's `.pi/extensions/redraws.ts` project extension is now the in-tree builtin
  `packages/coding-agent/src/core/extensions/builtin/redraws.ts` (registered from `builtin/index.ts`), and its
  `ExtensionAPI` import resolves relatively via `../types.ts` instead of the published
  `@earendil-works/pi-coding-agent` package.
- Behavior is unchanged: `/tui` renders one custom UI frame to read `tui.fullRedraws`, then notifies
  `TUI full redraws: <count>` — the diagnostic for how many full redraws the TUI has performed.

### Why

- The fork does not carry upstream's `.pi` project-extension directory; as a builtin the diagnostic ships with the
  agent and is registered for every session instead of depending on project-local discovery.

### Why an extension could not handle it

- It already is an extension; the tracked divergence is the file's location and import style, which only the
  repository layout controls.

### Expected merge conflict zones

- LOW: the `redraws.ts` import header (upstream still ships the file under `.pi/extensions/`); the command body is
  upstream-owned.

## Upstream .pi prompt-url-widget and TPS extensions relocated in-tree (2026-08-17)

### What changed

- `.pi/extensions/prompt-url-widget.ts` (deleted at the pin) lives on as the fork builtin
  `packages/coding-agent/src/core/extensions/builtin/prompt-url-widget.ts`, resolved through the global default
  extension factory fast path rather than `.pi` discovery; `DynamicBorder` now imports from the interactive-mode
  component (`../../../modes/interactive/components/dynamic-border.ts`) instead of the published package, and the
  GitHub security-advisory draft branch of the upstream widget was dropped (PR/issue prompt patterns remain).
- `.pi/extensions/tps.ts` (deleted at the pin) lives on as the fork builtin
  `packages/coding-agent/src/core/extensions/builtin/tps.ts`: assistant elapsed time is accumulated per
  `message_start`/`message_end` pair on the monotonic `performance.now()` clock, so a wall-clock jump backward can no
  longer suppress a valid TPS notice, and the turn notification uses the concise cache-hit form (entries below:
  2026-08-06, 2026-07-31).

### Why

- The fork does not carry upstream's `.pi` project-extension directory, and both widgets are expected in every
  session; the in-tree builtin/global-default surface keeps them pinned to the fork's runtime instead of drifting
  with a project-local checkout.

### Why an extension could not handle it

- Both already are extensions; the tracked divergence is the relocation of upstream-owned paths (deletion of
  `.pi/extensions/prompt-url-widget.ts` and `.pi/extensions/tps.ts` plus fork-only destination files), which only the
  repository layout controls.

### Expected merge conflict zones

- NONE in-tree: the destination files are fork-only. Upstream continues to evolve the `.pi` originals; on sync, port
  deliberate upstream fixes into the builtin copies rather than restoring the `.pi` files.

## Missing apply_patch extension seams (2026-08-17)

### What changed

- Records as tracker inventory the seams the `gpt-apply-patch` builtin compensates for because the host provides no
  extension hook there: there is no builtin-extension seam between app-server projection of a completed `apply_patch`
  result and its persistence into the session transcript, so completed-result retention is a fixed documented budget
  inside the tool (complete unified patches retained only up to 16 KiB per file; omission instead of an invalid
  partial diff — `gpt-apply-patch/changes.md`, 2026-08-02).
- Core consumers instead learned the tool's shape: compaction's `extractFileOpsFromMessage()` recognizes `apply_patch`
  calls and records patched paths as edited (compaction tracker, 2026-08-17), because no extension seam exposes a
  builtin tool's file mutations to core file-operation accounting.

### Why

- `apply_patch` deliberately replaces `edit`/`write` in the active tool set for eligible wire modes; host surfaces
  that assumed those core tools (projection, persistence, file-op extraction) need either a new seam or an explicit
  in-tool contract. The fork chose documented fixed contracts over host seams that would exist for exactly one
  builtin.

### Why an extension could not handle it

- These are seams the host would have to provide — a post-projection pre-persistence hook and core file-operation
  extraction; an extension cannot insert itself into a pipeline position the runner never dispatches.

### Expected merge conflict zones

- NONE: documents contracts in fork-owned builtin files (`gpt-apply-patch/`) and cross-references sibling trackers; no
  upstream file changes.

## cursor-cli-oauth: register the Cursor CLI fallback lane (2026-08-17)

- `index.ts` imports the `cursor-cli-oauth` extension and registers it in `builtinExtensions` beside `claude-sdk-oauth`, one `BuiltinExtensionFactory` entry: `{ id: "cursor-cli-oauth", factory: cursorCliOauthExtension }`.
- Registration is unconditional and probing-free: the factory registers the provider immediately with an offline static model catalog (the probe-backed catalog replaces it asynchronously) and reports executable/auth state through its oauth `check`, so the registry itself never blocks on, waits for, or conditions the entry on the external `cursor-agent` binary.
- Why beside `claude-sdk-oauth`: both are provider-lane extensions whose only ordering requirement is "present before model-catalog feeders observe them"; neither mutates another extension's state, so their relative order is not load-bearing (same slot as the existing entry).
- Positioning (plan addendum): the native Cursor provider (`cursor`, api2.cursor.sh protobuf transport shipped in v2026.8.16) stays the first-party primary path; this lane is the documented fallback for when the native path does not work well or Cursor's own agent harness is explicitly wanted.
- Why an extension boundary could not avoid this edit: `builtinExtensions` is a core-owned array with no self-registration hook - a builtin provider cannot join the registry from outside this file. This one entry is the lane's entire footprint here; all behavior lives under `cursor-cli-oauth/` (see that directory's `changes.md`/`AGENTS.md`; the display-name row is recorded in `core/changes.md`).
- Expected merge conflict zones: MEDIUM in `index.ts` at the import cluster and the registry array — every new builtin lane edits the same two hunks.

## service-tier: per-model /fast persistence across sessions (2026-08-16)

- `/fast [on|off]` now persists the choice per model in settings `modelServiceTiers` (global scope, nested-key write so concurrent sessions merge safely), so fast mode survives a restart instead of dying with the session. No-arg `/fast` keeps the established toggle UX; argument completions are `on` and `off`.
- `on` writes `${provider}/${id}: "priority"`; `off` writes an explicit `"auto"` — never a deleted key, because deletion silently re-inherits a catalog/`-fast` priority tier that the user just turned off.
- A `-fast` catalog variant and its base model are one choice to the user, so both read and write ONE key: `-fast` is normalized onto its base model through the existing `findBaseModel` helper, so `model` and `model-fast` can never hold contradictory preferences.
- `session_start` reads the memory (instead of unconditionally resetting to false): for `openai-codex-responses` models the flag is `remembered === "priority" || (remembered === undefined && ctx.serviceTier === "priority")` — a remembered `"auto"` wins over a catalog-inherited priority tier, and a model that is already served at priority (models.json entry, scoped pin) with nothing remembered starts fast. The flag is derived from the POST-swap model, so a `-fast` catalog variant is judged on the base model the user ends up on. Malformed/garbage values read back as `undefined` (never throw at startup). The existing `-fast` -> base model swap on start is unchanged.
- Tier precedence (request side): explicit scoped/favorite `:priority` pin > catalog compat `serviceTier` > `openai.serviceTier` (still applied in the non-Codex path). The per-model memory is not a step in `_resolveServiceTier`; it reaches the wire only for `openai-codex-responses` models via fast mode (session-start default, plus the `"auto"` suppression of a catalog-inherited priority). A pin is recognized as a priority tier the catalog does not explain (`ctx.serviceTier === "priority"` while `modelRegistry.getServiceTier(model) !== "priority"`), which covers favorite pins too — scanning `scopedModels` alone would miss them. Under a pin, `/fast off` notifies `Fast mode is fixed by the active model selection's priority tier.` and writes nothing. Non-Codex models keep `Fast mode is only available for OpenAI Codex models.`
- The memory is applied in the extension layer (it owns the fresh settings read) rather than cached in `AgentSession._resolveServiceTier`: caching there would survive a same-session `/fast off` (no model switch to re-resolve) and leak an inherited priority onto the wire. `AgentSession.setSessionFastMode(false)` instead clears the cached priority tier for codex-response models when that priority is INHERITED from the catalog (never when it is a `:priority` pin), so a same-session `/fast off` takes effect immediately on both the badge and the wire; `_resolveServiceTier` itself is unchanged apart from its doc. The extension additionally tracks the live memory tier (per base key, RE-DERIVED on `model_select` for the incoming model — read that model's own memory rather than dropping the previous model's, so switching away and back in one session cannot resurrect a catalog-inherited priority the user turned off) to suppress a CATALOG-EXPLAINED priority in `before_provider_request` after `/fast off`; the suppression requires `modelRegistry.getServiceTier(model) === "priority"` so a config-time `:priority` pin (resolved before `session_start`, hence live alongside a remembered `"auto"`) still reaches the wire — the same pin-vs-catalog discriminator `applyFastMode` uses to refuse `/fast off`.
- Exports a single reusable entry point `applyFastMode(ctx, enabled)` (plus `getRememberedServiceTier` / `resolveServiceTierMemoryModel` / `CODEX_RESPONSES_API`); todo 11's RPC `set_fast_mode` will call the same function so persistence and normalization exist once.
- Coverage: new `test/suite/fast-mode-persistence.test.ts` (16 cases — restart on/off, on->restart->off->restart->on, same-session off wire effect, no-arg toggle, bad argument, completions, `-fast` normalization to one key, explicit-auto beats catalog priority (+ control), config-time pin keeps the wire tier despite a remembered auto, remembered auto survives a switch away and back, malformed memory, stale memory, scoped-pin block, favorite-pin block, non-Codex, nested-key concurrent write) and `test/suite/fast-mode-manual-qa.test.ts` (real-handler manual-QA probe writing `task-10-manual-qa.txt`). `test/suite/service-tier-extension.test.ts`: "drops on restart" became "carries into a new session, drops only on `/fast off`"; the old "catalog flex wins over session fast" case now asserts the memory-over-catalog precedence (`/fast on` outranks a catalog `flex`), with an un-toggled control keeping `flex`. Regression fences: `test/model-runtime-catalog-service-tier.test.ts`.
- Expected merge conflict zones: LOW in `service-tier.ts` (session_start + handler rewrite + before_provider_request); LOW in `agent-session.ts` at `setSessionFastMode` (clear-on-off) — `_resolveServiceTier` itself is untouched.

## reasoning: capability-aware /reasoning and /efforts commands (2026-08-16)

- New builtin `reasoning/` registers `/reasoning [on|off]` (the on/off axis) and `/efforts [minimal|low|medium|high|xhigh|max]` (the effort ladder). Registered next to `service-tier`: both are read-the-active-model command surfaces that only notify, so their relative order is not load-bearing.
- Behavior branches on `classifyReasoningCapability(model)` (`core/thinking-levels.ts`), never on model ids or `thinkingFormat`. Each invocation re-classifies `ctx.model`, so a mid-session model switch is honored immediately and no capability is cached:
  - `none` — `/reasoning on` and both `/efforts` forms answer `Model <provider/id> does not support reasoning.`; `/reasoning off` is an idempotent `Reasoning: off.`
  - `always-on` — `/reasoning off` answers `Reasoning cannot be disabled for <provider/id>.`
  - `on-off` — `/efforts` answers `Reasoning effort is not configurable for <provider/id>; this model supports on/off only. Use /reasoning on or /reasoning off.`
  - `graded` — the full ladder, with `xhigh`/`max` offered only when the catalog says the model has them.
- `/reasoning on` restores, in order: this model's persisted `modelLastOnThinkingLevels` entry, a legacy non-off `modelThinkingLevels` entry, the global `defaultThinkingLevel`, then `medium` — always clamped to a supported non-off level. `/reasoning off` persists the effective `off` state without erasing the companion level, so the same off/on sequence restores identically before and after restart; no session-scoped fallback map remains.
- No-arg forms notify status only and never open a selector, so both commands work headless and over RPC. No `/thinking` alias is registered.
- Effort completions are dynamic: the ladder is read from the live model (tracked via `session_start`/`model_select`, since completion callbacks receive only a prefix) and suppressed entirely for non-graded models.
- Coverage: `test/suite/reasoning-commands.test.ts` (41 cases) pins every user-facing string verbatim across all four capability classes, plus malformed input (wrong case, extra args, unicode, whitespace-only, `off` as an effort) and a mid-session model switch.
- Expected merge conflict zones: LOW in `builtin/index.ts` at the import block and the registration array entry after `service-tier`.

## loop-guard: hard escalation uses the existing pre-tool and system-abort APIs (2026-08-17)

- Loop-guard moved to the first builtin slot and now combines its
  `tool_execution_start` observation with the existing vetoable `tool_call`
  hook. Two ignored identical-loop reminders arm blocking after the current
  turn; three blocked repeats claim a shared wake-source lease, show a
  transcript/UI warning, and interrupt with a system abort. Settlement then
  triggers a hidden recovery message as a fresh provider user-role turn and
  releases the lease when that turn starts. Similar/cycle warnings remain
  non-blocking.
- The implementation stays extension-only: no `types.ts`, runner, agent-loop,
  or public extension API changes. Existing error-result and system-abort
  contracts preserve active Goals; shared wake-source plus continuation-hold
  events prevent immediate and timer-driven duplicate Goal recovery.
- Why the registration move is required: `ExtensionRunner.emitToolCall`
  returns on the first blocker. Repeated calls must be stopped before
  settings-configured PreToolUse hooks and permission prompts repeat their own
  work.
- Coverage: focused loop-guard hard-escalation and Goal-isolation suites,
  saturation detector coverage, package TypeScript, and real CLI QA.
- Expected merge conflict zones: MEDIUM in `builtin/index.ts` at the first
  registration slot; LOW in the loop-guard directory and focused tests; NONE
  in public APIs or Goal production code.

## import-repro: guard /ir against mid-run and mid-compaction dispatch (2026-08-09)

- Extension commands now dispatch immediately inside `AgentSession.prompt()` (immediate-extension-commands plan), including while a run is streaming and while compaction is active. `/ir` replaces the live session through `ctx.switchSession()`, which aborts the in-flight turn without confirmation and — during compaction — fire-and-forget aborts the compaction task and disposes the session while that task is still unwinding (`agent-session-runtime.ts` `teardownCurrent` -> `abort()` -> `dispose()`).
- The `/ir` handler now refuses with a warning notification (`/ir is unavailable while the agent is working`) when `ctx.isIdle()` is false or `ctx.isCompacting?.()` is true; idle behavior is unchanged, and the guard sits above argument validation so no fetch/write/switch work starts.
- Why a per-handler guard instead of a core gate: the mid-turn audit of all builtin commands found only session-replacing `/ir` unsafe under immediate dispatch; the rest are read-only/UI, append-only (`appendCustomEntry` does not bump the message revision and survives compaction as a branch ancestor), host-guarded (`ctx.reload()` vetoes streaming and compaction), or defended by core design (model and tool-set changes invalidate/abort compaction deliberately). Verdict table: `.omo/evidence/task-3-immediate-extension-commands.md`.
- Coverage: `test/suite/import-repro-builtin-extension.test.ts` asserts the notify+return path while streaming and while compacting, plus an idle passthrough control.
- Expected merge conflict zones: LOW in `import-repro.ts` at the top of the `/ir` handler; LOW in `import-repro-builtin-extension.test.ts` around the new probe helpers.

## tps: concise turn cache-hit notice (2026-08-06)

- The turn-completion TPS notification now renders
  `TPS <rate> tok/s. Cache hit <rate>%, <seconds>s` instead of repeating raw
  output, input, cache-read/write, and total-token counters.
- Cache hit is aggregated across every assistant message completed in the
  agent turn, using the same denominator as the lower footer:
  `cacheRead / (input + cacheRead + cacheWrite)`. A turn notice should describe
  the whole turn, rather than only the last assistant message within it.
- Why an extension change: `tps.ts` already owns the transient notification,
  receives the complete turn's messages through `agent_end`, and can compute
  the metric without widening the public extension context or changing the
  persistent footer.
- Coverage: `test/suite/tps-extension.test.ts` pins a multi-message 70.0% hit
  rate, a zero-read 0.0% edge, monotonic elapsed time, and exclusion of
  tool/permission waits.
- Expected merge conflict zones: LOW in `tps.ts` around the usage aggregation
  and notification string; LOW in `tps-extension.test.ts`.

## notice: shared transcript notice kit (2026-08-04)

- New internal module `src/core/extensions/notice/` (`spec.ts`, `box.ts`, `adapters.ts`) owns the loop-guard visual family as a shared widget: a `NoticeSpec` contract (title/tone/why/extra/expandedLine), `buildNoticeBox`, and `noticeMessageRenderer`/`noticeEntryRenderer` adapters.
- loop-guard, goal cache-warm, and the shared rule-activation renderer (project-rules + ttsr activations) now delegate to the kit with visual parity; their existing renderer suites pass unmodified.
- Reconciled with the concurrent rule-activation work below: this branch initially added a dedicated `ttsr-injection` entry renderer, but rule-activation records already give ttsr interventions a durable box, so that duplicate was dropped and `rule-activation/renderer.ts` now renders through the kit instead.
- Interactive fallback transitions (`retry_fallback_*`, `server_fallback_aborted`) render through `buildNoticeBox` via `InteractiveMode.showNoticeBox`, which sanitizes every line with `sanitizeTuiErrorMessage` (preserving the OSC/control-strip invariant the exhausted-error path relied on).
- Why not an extension API addition: the kit is an internal module imported like `retry-fallback/*` helpers; `types.ts` is untouched. Expected merge conflict zones: LOW (new directory plus one import per consumer).

## rule-activation: shared project-rules and TTSR notices (2026-08-04)

- Added `rule-activation/` as a presentation-only builtin module with a typed discriminated activation contract, defensive persisted-data parser, custom-entry append/registration helpers, and a compact/expandable Box/Text renderer.
- Project-rules and TTSR both register the same renderer so either extension still works when loaded alone. Project-rules records successful dynamic tool-path matches; TTSR records committed remediation while preserving its separate persistence entry and hidden model nudge.
- Why shared code is required: the two engines retain incompatible discovery, matching, deduplication, and remediation semantics, but the TUI needs one stable durable-entry contract instead of engine-specific raw transcript text.
- Coverage: `test/rules-before-agent-start.test.ts`, `test/ttsr/extension-wiring.test.ts`, and `test/suite/rule-activation-renderer.test.ts`.
- Expected merge conflict zones: the new `rule-activation/` directory and the small registration/append seams in `rules/index.ts` and `ttsr/index.ts`. Do not fold engine policy into the shared module during conflict resolution.

## service-tier: enable fast mode for Codex API extension providers (2026-08-03)

- `/fast` now checks the model's `openai-codex-responses` API capability instead
  of requiring the built-in `openai-codex` provider id. Extension providers
  such as `codex-pool` can therefore use the same session-level
  `service_tier: "priority"` path without shadowing the stock command.
- Non-Codex providers remain unchanged and still receive the existing warning.
- Coverage: `test/suite/service-tier-extension.test.ts` registers a
  `codex-pool` model on the Codex responses API, toggles `/fast` on and off,
  and verifies both the session indicator and the corresponding addition and
  removal of `service_tier: "priority"` in the emitted request payload.
- Expected merge conflict zones: LOW in `service-tier.ts` at the two Codex
  eligibility guards; LOW in `service-tier-extension.test.ts`.

## tps: monotonic elapsed-time source for assistant intervals (2026-07-31)

- `tps.ts` now derives assistant-message elapsed time from the monotonic
  `performance.now()` clock instead of wall-clock `Date.now()`. A wall-clock
  jump backward (NTP skew or manual time change) between `message_start` and
  `message_end` previously produced a non-positive `Date.now() - start`
  interval, which the `> 0` guard dropped, suppressing a valid TPS notice.
- Preserved: the stream-open start timestamp is still recorded at
  `message_start`; `finishActiveAssistantTiming` still runs at every
  `message_start`/`message_end`/`agent_end` so tool and permission waits stay
  excluded; the output numerator, notification text, and the `agent_start`
  reset behavior are unchanged.
- Coverage: `test/suite/tps-extension.test.ts` adds a deterministic regression
  where one second of fake monotonic time elapses but wall time is moved
  backward between `message_start` and `message_end`; the existing lockstep
  fake-timer case still pins TPS/token/elapsed text.
- Expected merge conflict zones: LOW in `tps.ts` around the two
  `performance.now()` call sites; NONE in the public extension API.

## loop-guard: tool-call loop detection with steered reminders (2026-07-31)

- New builtin extension `loop-guard` (registered before `config-reload`; MCP stays last)
  that watches the pure `tool_execution_start` stream and steers a
  `<system-reminder>` CustomMessage into the running turn on three loop shapes:
  identical calls (trailing run >= 3 of byte-identical tool+canonical-args),
  near-identical same-tool runs (>= 5 calls at mean adjacent bigram-Dice >= 0.85),
  and cyclic rotations (period 2..6 repeated >= 3 times). Each kind gets its own
  reminder prompt; a shared gate re-fires only at 2x the last notified count and
  resets on `session_start` / real user input.
- TUI notice via `pi.registerMessageRenderer("loop-guard:notice", ...)` in the goal
  cache-warm Box style. Threshold rationale (gemini-cli / OpenHands prior art plus a
  400-session local corpus) is recorded in `loop-guard/changes.md` and `policy.ts`.
- Tests: `test/suite/loop-guard-detectors.test.ts` and
  `test/suite/loop-guard-extension.test.ts` (fake-pi harness, zero tokens).
- Expected merge conflict zones: LOW in `builtin/index.ts` (one import + one array
  entry before `config-reload`); NONE in `types.ts` (no public API change).

## service-tier: mirror the Codex fast toggle into the session indicator (2026-07-31)

- The session toggle added on 2026-07-31 lived only inside this extension, so no host surface could
  tell that fast mode was on. It now calls `pi.setSessionFastMode()` on every toggle and clears the
  flag on `session_start`, which is what lights the TUI footer's lightning indicator.
- `test/suite/service-tier-extension.test.ts` asserts `session.isFastModeActive()` across the
  toggle and the `session_start` reset.
- Expected merge conflict zones: LOW in `service-tier.ts` around the no-variant toggle branch and
  the `session_start` handler.

## service-tier: `/fast` toggles a session priority tier on subscription Codex models (2026-07-31)

- Fixes issue #545 and reverses the conclusion of the 2026-07-30 entry below. `/fast`
  on an `openai-codex` model has no `-fast` catalog sibling to switch to, and the
  previous change turned that into a "priority tier is not available on a ChatGPT
  subscription" notice. That premise was wrong.
- Measured with a live ChatGPT Pro token:
  `chatgpt.com/backend-api/codex/models?client_version=0.145.0` (originator
  `codex_cli_rs`) advertises
  `service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }]`
  and `additional_speed_tiers: ["fast"]` for gpt-5.6-sol/terra/luna, gpt-5.5 and
  gpt-5.4 (empty for gpt-5.4-mini and gpt-5.3-codex-spark). The first-party Codex
  CLI 0.145.0, routed through a logging proxy on subscription OAuth, sends
  `service_tier: "priority"` in the `POST /backend-api/codex/responses` body.
- The earlier "served at normal tier" reading came from the SSE echo, which is not
  a confirmation channel: `response.created` reports `auto` and
  `response.completed` reports `default` whether `priority` was sent or nothing was.
- The no-variant branch now toggles a session-scoped priority tier that the
  existing `before_provider_request` handler injects, so `/fast` reports
  `Fast mode enabled: <model>` and the next Codex request carries
  `service_tier: "priority"`. The tier is session-only (never persisted) and
  resets on `session_start`; an explicit model/scoped tier still wins.
- `test/suite/service-tier-extension.test.ts` replaces the "clear no-op" case with
  the toggle assertion on the payload, and covers a mid-session switch to another
  Codex model keeping the tier, a hop to a non-OpenAI model dropping it,
  explicit-tier precedence, and the `session_start` reset.
- Expected merge conflict zones: LOW in `service-tier.ts` around the
  `sessionFastMode` flag, the no-variant branch, and the
  `before_provider_request` tier resolution.

## service-tier: explain why `/fast` is unavailable on a subscription (2026-07-30)

- Fixes the misleading notice reported in issue #499. `/fast` is registered only
  for `openai-codex`, but `generate-models.ts` emits `-fast` priority variants
  only for the direct `openai` provider, so no Codex model ever has a target and
  the command could only ever answer "Fast mode is not supported for
  openai-codex/<model>" — which reads as a per-model gap rather than a
  plan-level limitation.
- Generating the missing Codex variants would be wrong. Measured against
  `chatgpt.com/backend-api/codex/responses` with a live ChatGPT Pro
  subscription: `service_tier: "priority"` and `"default"` both return HTTP 200
  and the response echoes `"auto"`, while `"auto"`, `"flex"` and `"scale"` are
  rejected with HTTP 400 `Unsupported service_tier`. The backend allowlists
  `priority` but serves it at normal tier, and
  `getServiceTierCostMultiplier()` would still bill it at 2.5x for gpt-5.5
  (2x elsewhere) — so synthesising variants would inflate reported cost for
  unchanged service.
- The no-variant branch now states that priority tier is unavailable on a
  ChatGPT subscription and that it requires API-key billing on the `openai`
  provider, where `-fast` variants already exist and `/fast` works.
- `test/suite/service-tier-extension.test.ts` asserts the notice explains the
  subscription limitation and no longer blames the model.
- Expected merge conflict zones: LOW in `service-tier.ts` around the
  `FAST_UNAVAILABLE_ON_SUBSCRIPTION` constant and the no-variant branch.

## service-tier: add `/fast` for OpenAI Codex (2026-07-29)

- `service-tier.ts` registers `/fast` only for the `openai-codex` provider.
  Enabling resolves the active model's compatible `-fast` catalog sibling,
  switches the current session to it, and derives priority mode from that
  selected model's `upstreamModelId` plus `serviceTier` metadata.
- Disabling restores the compatible base catalog model. `session_start` also
  restores the base model when a session opens on a fast variant, so the command
  remains session-scoped and never rewrites persisted model defaults.
- Models without a compatible priority variant and non-Codex providers receive
  clear no-op notifications.
- The shared service-tier payload injector now covers
  `openai-codex-responses`; explicit payload tiers remain authoritative.
- `test/suite/service-tier-extension.test.ts` covers session reset, both model
  switches, upstream request model plus priority tier, provider/model gating,
  non-Codex payloads, and explicit-tier preservation.
- Expected merge conflict zones: MEDIUM in `service-tier.ts` around the command
  and `before_provider_request` handler.

## resumption channels + goal: source-keyed liveness contract (2026-08-08, supersedes 2026-07-28)

- New `resumption-channel-event.ts` defines the internal `resumption_channel_state` pi-event as a full snapshot for one open-set `source`: `{source, activeCount, channels?}`. Sources are strings rather than an enum so terminal monitors, background bash, detached evals, senpi tasks, and future producers can share the contract without central registration.
- Goal stores one count per source and writes each incoming snapshot to that key. Legacy `terminal_monitor_state` and generalized `resumption_channel_state` emissions both write `"terminal-monitor"`, making dual emission idempotent: a count of two remains two and is never summed to four.
- Immediate-versus-delayed continuation, system-abort recovery, timer eligibility, wait labels, and stall context use the total across source keys. Timer cancellation and toolless-streak reset occur only when that total transitions from positive to zero; one source draining while another remains live has no zero-transition side effect.
- Goal subscribes at extension factory/construction scope rather than inside `session_start`, and keeps both subscriptions until disposal. `start()` clears prior-session counts. Every emitter must therefore publish transitions while live and re-emit its full current snapshot on `session_start` after Goal has reset, so the new session cannot inherit stale counts or miss live channels.
- Scheduled/resumed pi-events and `goal-cache-warmup` entries retain backward-compatible `activeMonitorCount` (terminal monitors only) and add `channelCounts` for the source-keyed snapshot. No public `ExtensionContext` or RPC protocol type changed.
- Expected merge conflict zones: emitters in sibling-owned terminal/task/eval modules; LOW in Goal continuation telemetry and wait presentation; NONE in `extensions/types.ts`.

## bash-timeout: beyond-max routing to run_in_background + monitor (2026-07-28)

- `bash-timeout/timeout.ts` `buildBashTimeoutPrompt()`: the beyond-max bullet no longer teaches
  "run them in the background via tmux or a similar mechanism" — it now routes to
  `run_in_background: true` with the decisive output watched via `monitor`. The old advice
  directly contradicted TERMINAL_PROMPT_SECTION ("do NOT use tmux"), which is appended to the
  same system prompt immediately after this section (builtin #11 → #12), and contradictions
  destabilize instruction following more than missing detail.
- `test/suite/bash-timeout-extension.test.ts`: the "references tmux as the escape hatch" pin is
  replaced by the new contract (run_in_background + monitor present, tmux absent).
- Expected merge conflict zones: LOW — fork-owned `timeout.ts` prompt string and its test.

## Remove the /sessions session-observer HUD (2026-07-26)

- Deleted the `session-observer/` builtin (11 files: `index`, `loader`, `overlay`, `overlay-format`, `scanner`, `text`, `transcript`, `transcript-entries`, `transcript-format`, `types`) and its three vitest suites (`session-observer-picker`, `session-observer-overlay`, `session-observer-scanner`).
- `builtin/index.ts`: dropped the `sessionObserverExtension` import and the `{ id: "session-observer", factory: sessionObserverExtension }` entry from `builtinExtensions`.
- `core/keybindings.ts`: removed the `app.sessions.observe` keybinding (interface entry, the `ctrl+s` default binding, and the `observeSessions` alias). `ctrl+s` is freed and intentionally not rebound.
- `modes/interactive/interactive-mode.ts`: removed the `app.sessions.observe` -> `/sessions` action handler and the `/hotkeys` row that advertised "Observe session transcripts".
- `AGENTS.md` and the root `README.md` extension table: dropped the `session-observer` row and renumbered the subsequent entries (26 -> 25 in-tree extensions).
- `docs/keybindings.md`: dropped the `app.sessions.observe` row.
- `utils/changes.md`: corrected the stale `shortenPath()` note that claimed it backed the `/sessions` HUD picker; `shortenPath()` itself stays (other consumers remain).
- Neo (the Go TUI) shipped a native port of the same HUD; it was removed in lockstep to satisfy the repo-wide "no /sessions HUD source" contract: `internal/ui/builtinext/{observer,observer_overlay,observer_viewer,observer_test,transcript,transcript_decode,transcript_render}.go`, the `ResolveSessionsCommandOutcome` resolver and its tests, the `app.sessions.observe` keybinding definition/scope/migration/registry-test entries, the qaharness `observer` scenario, the welcome-menu entry that advertised it, the `/sessions` command in the bridge `get_commands` testdata, and the `task-14-session-observer-tail` visual-claims manifest entry plus its triplet.
- Why: user-requested cleanup. The HUD duplicated `/resume`'s session-picking surface and the `ctrl+s` chord collided with the more useful `app.session.toggleSort` / `app.models.save` chords that already bind `ctrl+s` in other scopes.
