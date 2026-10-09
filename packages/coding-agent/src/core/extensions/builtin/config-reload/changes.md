# config-reload Extension Changes

## 2026-10-09 - Concurrent log rotation never disables a log sink (senpi#2976)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/config-reload/log.ts`: rotates through `rotateLogIfNeeded`; a failed write returns `{ written: false, disabled: true }` and retries after `LOG_SINK_RETRY_MS` instead of disabling the logger for the process lifetime.

### Why

- Several processes share one agent dir (engine host, CLI, desktop host). Rotation was a non-atomic stat, remove `.1`, rename: when two crossed the cap together, the loser's rename threw ENOENT and its sink stayed disabled for the rest of the process, and the remove step could delete a generation another process had just rotated. A four-process burst dropped hundreds of lines per losing process. Rotation now goes through `core/log-file-rotation.ts` (an exclusive lock file and a size re-check under it), a lost race keeps appending, a failed sink retries after `LOG_SINK_RETRY_MS` (5 s), and the mode is set on the open descriptor.

### Why an extension could not handle it

- This is the builtin extension's own log writer.

### Expected merge conflict zones

- LOW: `createConfigReloadLogger` and `writeLine` in `config-reload/log.ts`.

## 2026-10-08 - Stop the post-reload handoff from re-triggering reloads (#2878)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts`: the post-reload handoff comparison (`compareHandoffSnapshots`) no longer counts a path that is missing from the new watcher baseline but still on disk as changed. Such a path belongs to an extension whose watch registration arrives after `session_start`; it is held in `awaitingRegistration` and compared against its pre-reload hash once that registration rebuilds the watchers (`settleAwaitingRegistration`). A deleted path still counts as changed.
- Reloads triggered only by the handoff comparison carry a chain counter; after `MAX_HANDOFF_RELOADS` (3) consecutive such reloads the chain stops, with no time window, so a slow cycle (for example one held back by running subagents) cannot restart it, logs `reload_loop_stopped` at warn level and shows a notice instead of reloading again. A watcher-detected change resets the chain.
- The extension-veto recheck keeps its 1 s cadence for the first five attempts, then backs off exponentially to at most 30 s; `agent_end` and `agent_settled` still flush immediately. `reload_deferred` is logged once per veto reason instead of on every recheck.
- `packages/coding-agent/src/core/extensions/builtin/config-reload/log.ts`: new `reload_loop_stopped` event with `paths` and `reloads`.

### Why

- Extensions (omo) re-register their config-watch targets after the config-reload `session_start` handler. The handoff compared the pre-reload baseline, which held those targets, with a baseline that did not yet, so an untouched extension-only file always looked changed and every reload queued the next one (#2878). One session reloaded every ~14 s for over an hour and reached ~20 GB physical footprint.
- A session with long-running subagents rechecked a vetoed reload, and logged `reload_deferred`, once per second for as long as the subagents ran (thousands of lines per session in `config-reload.log`).

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts` owns the reload handoff, the watcher baseline and the veto recheck clock.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts` `processReloadHandoff`, `handleRegistration`, `flushPending`, `armVetoRecheck`; `log.ts` event union.

## 2026-10-01 - Ignore runtime-only project directory creation and preserve request admission

### What changed

- `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts`: rechecks the live idle, pending-message, and compaction state after awaiting extension reload vetoes.
- `packages/coding-agent/src/core/extensions/builtin/config-reload/change-groups.ts`: separates presence-watch rearming from a real configuration change. Newly discovered files still request a reload; creating only the project configuration container does not.
- Files discovered by that rearm pass through the same self-write, routine-settings and generated-shim filters as the event's own paths.

### Why

- The first prompt can begin while a reload veto handler is pending. The previous idle snapshot then allowed configuration reload to retire the generation during that prompt (oh-my-openagent#9365).
- Desktop task projections created an otherwise configuration-free project directory while the first request was starting (oh-my-openagent#9363). Directory discovery must not reload extensions merely because task runtime state appeared there.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts` owns pending configuration changes and the decision to request their reload.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/config-reload/index.ts`, `flushPending`, watcher rearming, and extracted change grouping.

## 2026-09-21 - Share one recursive FS-watch worker across sessions (#1794)

### What changed

- `watch-event-source.ts` hoists the recursive watch worker, its subscription table, and the subscription id counter from per-source closure state into a process-wide registry keyed by the worker-factory identity. The default factory resolves to a single entry, so every `createFsWatchEventSource()` without an injected factory — one per config-reload extension instance, i.e. one per session — shares one `node:worker_threads` Worker instead of each constructing its own.
- Subscriptions carry their owning source's `onError`, so message-kind errors and worker-death fan-out still reach the right handler while the worker is shared. Id-routed dispatch, crash replacement, and last-unsubscribe termination semantics are unchanged, now process-wide per factory key.
- New `resetFsWatchWorkersForTests()` export terminates live workers best-effort and clears the registry for test isolation.

### Why

- The shared in-process RPC host loads one config-reload instance per session and every session added one watch thread and a few MB (1,023 threads at 1,000 sessions — #1794). The watched directories are identical per host, so N workers were N-1 redundant.

### Why an extension could not handle it

- The event source and its worker lifecycle are internal to this builtin; no extension API controls worker construction.

### Expected merge conflict zones

- MEDIUM: `watch-event-source.ts` worker registry and `createFsWatchEventSource` body. Tests extended in `test/suite/config-reload-worker-shutdown.test.ts` and `test/rpc-multi-session-isolation.test.ts`.

## 2026-09-14 - Join watcher disposal and skip nonpersistent RPC probes (#1656)

### What changed

- Watch-worker registration checks a shared cancellation flag before and after `fs.watch`, so a shutdown that wins the post-load/pre-registration interleaving never retains a native watcher.
- `ConfigReloadWatchEngine.close()` cancels synchronously and joins returned disposers; repeated close shares that join and surfaces `AggregateError` if any disposer fails.
- `session_shutdown` awaits those joins. Nonpersistent RPC sessions (`getSessionFile() === undefined`) do not start OS watches.

### Why

- Fire-and-forget unsubscribe during exit left FSEvents streams running into process teardown (`pthread_join` hang). Snapshot-only RPC probes never needed live watches.

### Why an extension could not handle it

- The event source and watch engine are internal to this builtin; process shutdown must observe their disposal.

### Expected merge conflict zones

- MEDIUM: `watch-event-source.ts` worker source and unsubscribe join; `watch-engine.ts` `close()`; `index.ts` `session_shutdown` / `rebuildWatchers`.

## 2026-09-11 - Keep per-source changelog acknowledgements routine (senpi#1583)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/config-reload/routine-settings.ts`: classifies `changelogSeen` as routine settings during reload filtering.

### Why

- Acknowledging a changelog must not trigger a substantive configuration reload or cascade across sessions.

### Why an extension could not handle it

- The routine-setting classification is internal to the builtin reload diff before extension callbacks run.

### Expected merge conflict zones

- LOW: the routine settings key set.


## Offload non-recursive watch creation to the worker (2026-09-02)

### What changed

- `watch-event-source.ts` routes EVERY `fs.watch` subscription — recursive and
  non-recursive — through the existing watch worker on darwin and linux. The
  worker message gained a `recursive` flag; the worker passes it to `fs.watch`.
- Windows (and other platforms) keep the direct main-thread `fs.watch` path.

### Why

- The per-directory watch redesign (2026-08-20) made every engine subscription
  `{ recursive: false }`, which silently bypassed the worker offload added for
  recursive watches: the offload gate required `watchOptions.recursive`. Every
  FSEvents stream was again created synchronously on the interactive main
  thread. Measured with PI_TIMING + dist probes on an M4 Pro under load:
  `#attach` cost 8.0s for `~/.omo/agent/extensions` and 2.7s for the cwd
  target; `rebuildWatchers` inside config-reload's `session_start` handler hit
  89s worst-case, dominating the reload `lifecycle` phase (2.0-3.2s idle,
  12s+ loaded). After offloading: lifecycle ~150ms, reload total ~180-230ms.

### Why an extension could not handle it

- The event source is internal to this builtin; nothing outside it controls how
  subscriptions reach `fs.watch`.

### Expected merge conflict zones

- LOW: `watch-event-source.ts` offload gate and worker source string;
  `config-reload-extension.test.ts` macOS offload describe block.


## Watch only in-scope directories instead of whole subtrees (2026-08-20)

### What changed

- `watch-engine.ts` no longer hands a `dir-recursive` target root to
  `fs.watch({ recursive: true })`. The scan already computes the in-scope
  directory set (skipping `node_modules`, `.git`, symlinks, dot-directories that
  are not explicitly allow-listed, and anything the target `filter` rejects), so
  the engine now records those directories as `scannedDirectories` and opens one
  non-recursive subscription per directory.
- `#onEvent` takes the watched directory and re-anchors the reported filename to
  the target root, because a per-directory watcher names children relative to
  itself.
- `#attach` / `#detachMissing` reconcile subscriptions after every full and
  partial rescan, so directories created after startup gain a watcher and
  directories that leave scope release theirs.

### Why

- `fs.watch({ recursive: true })` registers the entire subtree with the OS
  watcher (FSEvents on macOS). The target `filter` only discards events after
  delivery, so a `~/.omo/extensions` or skills directory containing
  `node_modules` still paid for a full-subtree registration in every session.
  Measured on this machine: `fseventsd` at 123% CPU and 3-4.3GB RSS with load
  above 200, and the only available mitigation was disabling `configReload`
  entirely. Watching the scanned set gives identical change coverage because the
  scan and the subscriptions now derive from the same scope rules.

### Why an extension could not handle it

- The watch engine and its event source are internal to this builtin; no
  external extension can change how config watch targets reach `fs.watch`.

### Expected merge conflict zones

- MEDIUM: `watch-engine.ts` constructor subscription loop, `#onEvent` signature,
  `#evaluateState`, and the `ScanResult` / `TargetState` shapes.
- LOW: `config-reload-watch-engine.test.ts` event-source probe, which now keeps
  one listener per watched directory instead of a single listener.

## Clear orphaned handoff unconditionally after reload (2026-08-20)

### What changed

- `index.ts` now captures the handoff key before `requestReload()` and deletes
  the registry entry unconditionally when the promise settles, removing the
  `tornDown` guard that skipped deletion after a real reload.
- The `tornDown` closure variable was removed entirely; it was only read by
  the deleted guard.
- A regression test verifies that a reload whose successor omits config-reload
  does not leave a stale handoff for a later reload to consume.

### Why

- If the settings change disabled config-reload, the successor never called
  `take()`, so the handoff survived for the process lifetime — now including
  plaintext settings contents. A later reload that re-enabled the builtin
  consumed and replayed the stale change.

### Why an extension could not handle it

- This builtin owns both the session reload handoff and the routine-settings
  snapshot used by the protected config watcher.

### Expected merge conflict zones

- LOW: `index.ts` `flushPending` try/catch block and `session_shutdown` handler.

## Preserve cross-process routine filtering through reload handoff (2026-08-20)

### What changed

- `index.ts` now carries the pre-reload settings-content snapshots through each
  session-keyed reload handoff and restores them before classifying filesystem
  changes found during the reload window.
- A regression verifies that a concurrent `defaultModel` write does not cause
  the replacement extension to request a second full reload.

### Why

- Rebuilding a watcher refreshed its settings snapshot before handoff changes
  were classified. A peer process's routine-only write then compared current
  content to itself, bypassed routine filtering, and could cascade into reload
  storms across sessions sharing an agent directory.

### Why an extension could not handle it

- This builtin owns both the session reload handoff and the routine-settings
  snapshot used by the protected config watcher.

### Expected merge conflict zones

- LOW: `index.ts` `ReloadHandoff`, reload request state capture, and
  `processReloadHandoff`; LOW in `config-reload-extension.test.ts` around the
  existing reload-window coverage.

## Watch and validate JSONC settings (2026-08-16)

### What changed

- Built-in global/project settings watches now admit both `settings.jsonc` and `settings.json`.
- Validation and routine-change classification use the shared dependency-free settings parser, and content snapshots cover both filenames.

### Why

- Loading JSONC without watching it would make automatic reload behavior depend on the file extension and leave valid JSONC edits inert.

### Why an extension could not handle it

- This builtin owns the protected config watch targets, self-write suppression, validation, and reload handoff.

### Expected merge conflict zones

- LOW: settings filename allowlists and validator in `index.ts`; settings path/snapshot parsing in `routine-settings.ts`.

## Treat durable last-on reasoning memory as a routine setting (2026-08-16)

### What changed

- Added `modelLastOnThinkingLevels` to the routine settings keys suppressed from full config reloads.

### Why

- Reasoning commands update this per-model companion alongside the already-routine effective thinking memory;
  other running sessions do not need to reload extensions when it changes.

### Expected merge conflict zones

- LOW: `routine-settings.ts` in `ROUTINE_SETTINGS_KEYS`.

## Filter-aware agent-directory watch guard (2026-08-14)

### What changed

- `registrationHasRestrictedTarget` now accepts a watch rooted exactly at the agent directory when every `filterGlob` is root-anchored (a leading `/`, which matches only an immediate child of the watch root) and none of those anchored names resolves into a protected path (`auth.json`, `sessions/`, `logs/`).
- Unfiltered agent-dir targets, unanchored filters such as `omo.json` (which match at any depth), and any filter that names a protected path remain rejected (fail-closed).

### Why

- The guard predates root-anchored filters and rejected the agent directory outright even when the filters could only ever select safe root config files, so extensions could not live-watch e.g. `omo.jsonc` and had to tell users to reload manually.

### Why an extension could not handle it

- The protected-target guard runs inside this builtin at registration intake; an external extension cannot relax it.

### Expected merge conflict zones

- LOW: `index.ts` `registrationHasRestrictedTarget` and the new `isSafeFilteredAgentDirTarget`; LOW in `config-reload-extension.test.ts`.

## Accept filtered ancestor config-watch targets safely (2026-08-26)

### What changed

- Generalized the protected-path registration guard so directory targets covering the agent directory are accepted when every filter glob is root-anchored and each resolved path stays outside protected paths in both directions. Targets inside protected paths, unfiltered targets, unanchored filters, and filters naming protected paths remain rejected.

### Why

- Issue code-yeongyu/oh-my-openagent#7064: the default `~/.omo/agent` layout made the omo extension's user-config watch target at `~/.omo` rejected, even though its anchored `/omo.jsonc` and `/omo.json` filters are confined to safe files.

### Why an extension could not handle it

- The protected-target guard runs inside this builtin during registration intake, before an external extension's filtered watch can be stored or watched.

### Expected merge conflict zones

- LOW: `index.ts` protected-target filtering and `config-reload-extension.test.ts` restricted-registration coverage.

## Off-main-thread recursive watchers on macOS and non-blocking teardown (2026-08-20)

### What changed

- `watch-event-source.ts` routes recursive watches through the existing worker thread on `darwin` as well as `linux` (`WORKER_OFFLOADED_RECURSIVE_PLATFORMS`); creation and teardown of recursive `fs.watch` handles no longer run on the interactive main thread on macOS. Non-recursive watches are unchanged.
- `ConfigReloadWatchEngine.close()` now returns `Promise<void>`: it flips the `#closed` dispatch guard and clears the debounce timer synchronously, then drains the unsubscribe loop on a 0ms clock tick. `closeWatchers()` in `index.ts` fires that teardown without awaiting it, logging failures via the existing `watcher_error` logger shape.

### Why

- Hot reload awaits this extension's `session_shutdown` handler. On macOS each recursive `FSWatcher.close()` is an FSEvents stream teardown that blocks the calling thread — measured 5.2-13.9s per watcher on a loaded M4 Pro (44.8-62.8s for 8 watchers; ~150-200ms each idle), making `/reload` and config-watch reloads stall for seconds to a minute. The engine is inert the moment `#closed` flips, so nothing on the reload path needs teardown completion.

### Why an extension could not handle it

- The watch engine, its event source, and the `session_shutdown` ordering are all internal to this builtin; no external extension can change how the host awaits the shutdown handler or where `fs.watch` handles are created.

### Expected merge conflict zones

- MEDIUM: `watch-engine.ts` `close()` signature (`void` -> `Promise<void>`) and any upstream callers that await or type it.
- LOW: `watch-event-source.ts` platform gate; `index.ts` `closeWatchers`.
- LOW: `config-reload-extension.test.ts` (macOS offload block appended; two teardown-timing assertions restated as behavior assertions) and the new `config-reload-lazy-teardown.test.ts`.
