# config-reload Extension Changes

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
