# config-reload Extension Changes

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
