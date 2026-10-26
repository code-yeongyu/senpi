# changes.md — rules (vendored)

Vendored from [`code-yeongyu/pi-rules`](https://github.com/code-yeongyu/pi-rules) (see `external-versions.json`).

## 2026-09-24 - Sync with pi-rules 0.2.0 (senpi#2079)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/rules/rules/constants.ts`, `rules/types.ts`, `rules/finder.ts`: `.pi/rules` (project) and `~/.pi/rules` (user home) are discovered ahead of `.omo/rules`; source priorities shift by one to make room.
- `packages/coding-agent/src/core/extensions/builtin/rules/rules/finder.ts`: only the first existing user-home single-file rule (`~/.config/opencode/AGENTS.md`, then `~/.claude/CLAUDE.md`) is returned, matching the documented first-match semantics.
- `packages/coding-agent/src/core/extensions/builtin/rules/rules/project-root.ts`: `findProjectRoot` realpaths the start path (a symlinked checkout resolves to the real project root) and returns `null` when the start path disappears between `existsSync` and `statSync`. New `widenToRepositoryRoot` widens a marker root to the innermost enclosing `.git` directory, ignoring a `.git` in the home directory.
- `packages/coding-agent/src/core/extensions/builtin/rules/rules/engine.ts`: dynamic discovery and target fingerprints canonicalize the target path and widen its project root to the repository root, so workspace members (nested `Cargo.toml` / `package.json`) reach repository-level `.github/instructions`. Root single-file rules are identified by `relativePath === source` instead of `distance === 0`, and dynamic loading keeps only the highest-priority root single-file rule per project root.
- `packages/coding-agent/src/core/extensions/builtin/rules/index.ts`: the native context-file set from `before_agent_start` is kept for the session, and `tool_result` skips (and marks as statically injected) rules pi already loaded natively. `session_start` resets the engine session before the disabled check. Upstream's per-session single-file set was not ported: senpi's `DYNAMIC_CONTEXT_SCOPE` already dedups every dynamic rule session-wide.
- `packages/coding-agent/src/core/extensions/builtin/rules/commands.ts`: `/rules show` without an id reports `Rule ID is required` instead of `Rule not found: `.
- `packages/coding-agent/src/core/extensions/builtin/rules/ui/rules-banner.ts`: banner diagnostics match a rule by absolute path as well as relative path.
- Not ported: upstream's `config.ts` `isTruthy` helper (same behavior as senpi's resolver) and the `formatter.ts` framing budget (senpi already budgets its larger envelope; see adaptations below).
- `packages/coding-agent/test/suite/rules-upstream-sync.test.ts` covers each ported behavior on a real temp filesystem.

### Why

senpi#2079 adopts the 2026-09-24 pi-* releases. pi-rules 0.2.0 carries monorepo rule discovery (pi-rules#31), `.pi/rules` sources (pi-rules#11), and the July audit fixes that senpi had not picked up. Without the repository widening, rules in a repository-level `.github/instructions` never fire for files inside workspace members.

### Why an extension could not handle it

Discovery, project-root resolution and the dynamic dedup state are private to this builtin; another extension cannot change which rule files it finds or which ones it injects.

### Expected merge conflict zones

- MEDIUM in `rules/engine.ts` `loadDynamicRules` / `fingerprintDynamicTargets` (widening and root single-file selection).
- LOW in `rules/index.ts` (`nativeContextPaths`, `session_start` reset), `rules/project-root.ts`, `rules/constants.ts`, `rules/finder.ts`, `commands.ts`, `ui/rules-banner.ts`.

## 2026-09-23 - Project-rules activations name the tool call they were injected into (senpi#2057)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/rules/index.ts`: the `project-rules` rule-activation entry carries `toolCallId` from the `tool_result` event whose content received the rules.

### Why

- The interactive TUI folds the notice into the Explored group of that call instead of rendering a standalone card that splits the group; the desktop app reads the same field.

### Why an extension could not handle it

- The rules extension owns the entry; only it knows which tool result received the injection.

### Expected merge conflict zones

- The `appendRuleActivation({...})` call at the end of the `tool_result` handler in `index.ts`.

## 2026-09-22 - claude-sdk-oauth provider id renamed to anthropic-subscription in the prompt-rebuild comment (senpi#1989)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/rules/rules/constants.ts`: doc comment points at the "Anthropic Subscription builtin" by its new display name.

### Why

Comment accuracy after the provider-id rename; no behavior change.

### Why an extension could not handle it

Vendored rule constants; nothing for an extension to override.

### Expected merge conflict zones

- `constants.ts` comment block, against the next vendored refresh from `code-yeongyu/pi-rules`.

## 2026-08-04 - Live-context dedup for dynamic rules

### What changed and why

- Dynamic rule matching and target fingerprints remain per tool target, but delivery dedup now uses one `live-context` scope for the active extension session.
- Reading a second target that matches an unchanged rule therefore does not append the same instruction body or another `Project rules` activation while that body remains in model context.
- Rejected compaction keeps the dedup state warm. Accepted compaction still calls `engine.resetSession(...)`, so a later matching tool result restores the rule after context loss.
- The existing rule-content hash remains part of the engine's dedup key, so editing a rule makes the updated body eligible for immediate re-injection without waiting for compaction.

### Why this cannot be supplied by another extension

- Dynamic injection filtering and `markDynamicInjected(...)` calls happen inside this builtin's private `tool_result` handler. A second extension cannot remove an already-appended instruction block or activation entry without duplicating and replacing the rules engine.

### Coverage and expected conflict zones

- Coverage: `test/rules-dynamic-cross-target-dedup.test.ts` verifies distinct-target suppression, rejected/accepted compaction boundaries, activation counts, and changed-content re-injection.
- Expected conflicts: `index.ts` around the dynamic `tool_result` filter and mark loop. Preserve the shared `DYNAMIC_CONTEXT_SCOPE` argument while keeping `fingerprintDynamicTargets(...)` target-specific.

## 2026-08-04 - Shared activation notices for dynamic rules

### What changed and why

- The vendored extension now registers Senpi's shared `rule-activation` entry renderer and appends a typed, display-only activation entry after a newly matched dynamic rule block is added to a tool result.
- The notice records the tool target and matched rule paths so the TUI can show a compact summary and expandable details instead of presenting the injected instruction block as undifferentiated tool output.
- Static `before_agent_start` delivery, dynamic fingerprint deduplication, and the exact model-facing instruction block are unchanged.

### Why this cannot stay upstream-only

- Upstream pi-rules owns matching and prompt delivery but does not own Senpi's custom-entry renderer registry or shared TTSR presentation layer. The adapter therefore belongs at the Senpi builtin boundary.

### Coverage and expected conflict zones

- Coverage: `test/rules-before-agent-start.test.ts` verifies unchanged dynamic model delivery plus the typed activation entry; `test/suite/rule-activation-renderer.test.ts` verifies standalone renderer registration and malformed persisted-data handling.
- Expected conflicts: `index.ts` around renderer registration and the dynamic `tool_result` return path. Preserve the shared activation append after `markDynamicInjected(...)` and before returning augmented tool content.

## Senpi adaptations vs upstream

- Imports rewritten by `scripts/vendor-transform.mjs`: `@mariozechner/pi-tui` -> `@earendil-works/pi-tui`; `@mariozechner/pi-coding-agent` symbols -> `../../types.ts` (and `Theme` -> `modes/interactive/theme/theme.ts`); relative `.js` import suffixes -> `.ts`.
- `ui/dynamic-border.ts` and `ui/rules-banner.ts`: constructor parameter properties (`private readonly …`) -> explicit fields + constructor assignment (senpi's root tsconfig is `erasableSyntaxOnly`; parameter properties are disallowed).
- Runtime dep `picomatch` (+ `@types/picomatch`) added to `package.json`.
- `rules/project-root.ts`: `findProjectRoot` stops the marker walk when `dirname()` stops progressing, fixing an infinite synchronous loop for targets on a different Windows drive than cwd (or UNC shares). Upstreamed as https://github.com/code-yeongyu/pi-rules/pull/19 and released in pi-rules 0.2.0, so this is no longer a divergence.
- `rules/finder.ts`: `isSameOrChildPath` rejects an absolute `relative()` result via `isAbsolute()` instead of `startsWith("/")`. On Windows, `relative()` between two different drive roots returns an absolute path (`relative("C:\\proj", "D:\\other")` -> `"D:\\other"`) that starts with neither `".."` nor `"/"`, so the containment test accepted it and `getWalkDirectories` walked the other drive — collecting `AGENTS.md` / `CLAUDE.md` / `.claude/rules` from an unrelated drive as *project* rules. Matches the sibling helper in `rules/engine.ts`, which already uses `isAbsolute()`. POSIX behavior is unchanged (`isAbsolute` and `startsWith("/")` agree there). Propose upstream in `code-yeongyu/pi-rules` and drop the adaptation once a release carrying it is re-vendored.
- `rules/finder.ts`: `getWalkDirectories` ends the upward walk on `relative(projectRoot, currentDirectory) === ""` instead of an exact string compare. Windows drive letters are case-insensitive, so a target under `c:\\workspace\\proj\\src` never matched a `C:\\workspace\\proj` root and the walk continued to `c:\\workspace` and `c:\\`; `findProjectCandidates` collects rules from every walked directory without re-checking containment, so an `AGENTS.md` above the project root was injected as a *project* rule. Same escape as the cross-drive entry above, reached through drive-letter case. `relative()` folds drive-letter case, and on POSIX the two comparisons already agree, so behavior there is unchanged. Propose upstream in `code-yeongyu/pi-rules` and drop the adaptation once a release carrying it is re-vendored.
- `rules/constants.ts` + `rules/formatter.ts`: `formatStaticBlock` wraps its output in a model-facing `<project_rules>` … `</project_rules>` envelope, and wraps that in opaque region sentinels (`PROJECT_RULES_REGION_START_MARKER` / `..._END_MARKER`). Provider lanes that rebuild the system prompt instead of forwarding senpi's composed one — the `claude-agent-sdk` builtin — need an explicitly bounded region to extract; unbounded, the block is either dropped entirely or read to end-of-string, which swallows the sections extensions registered later (`mcp`) append below it. The sentinels exist because the semantic `<project_rules>` tags cannot identify the block: surrounding prompt content this builtin does not own (context files before it, extensions appending after it) may legitimately contain them and would be extracted instead. Rule headings and bodies keep their text, except that the four marker literals are neutralized to their `&lt;…&gt;` form: a rule quoting a raw sentinel would terminate extraction early and silently drop every rule after it, while a rule quoting a raw semantic tag would corrupt the envelope structure the model reads. An extension cannot express any of this because the block is produced inside this builtin. Propose upstream in `code-yeongyu/pi-rules` and drop the adaptation once a release carrying it is re-vendored.
- `config.ts` + `index.ts` + `rules/types.ts`: back-port accepted upstream PR [`pi-rules#25`](https://github.com/code-yeongyu/pi-rules/pull/25) before a release is available. The built-in now resolves `PI_RULES_DISABLED`, `PI_RULES_MAX_RULE_CHARS`, and `PI_RULES_MAX_RESULT_CHARS` when its factory runs; integer limits require a whole-string positive safe integer, and the presence-only disable flag composes with the environment baseline instead of overwriting it with its registered `false` default on the first hook. This cannot be supplied by another extension because the engine config and flag synchronization are private to this builtin. pi-rules 0.2.0 contains that merge, so this is no longer a divergence.
- `rules/formatter.ts`: Senpi's extra semantic envelope, opaque sentinels, headings, absolute source headers, and separators are included in `maxResultChars`. Upstream budgets only rule bodies because it does not carry this Senpi-specific wrapper; without the adjustment, `PI_RULES_MAX_RESULT_CHARS=300` still produced a 547-character static block and a computed 600-character dynamic budget produced 893 characters. The formatter now subtracts observed formatting overhead and re-renders until the complete static or dynamic block fits, returning no empty envelope when the budget cannot hold one valid rule. An extension cannot fix this after the fact because the over-budget block has already been produced and inserted by this builtin.
- `index.ts`: `before_agent_start` no longer gates static rule selection on `engine.isStaticInjected(rule)`. The host re-emits that event from the BASE system prompt on every user prompt (`core/agent-session.ts`), so a mark written on turn 1 removed the block from turn 2 onward — on every provider, not just the SDK lane. The marks are still written; they now serve only the dynamic `tool_result` path's dedup. Same upstream-proposal note as above.
- Otherwise, behavior is unchanged. Registers `/rules` and `/reload-rules` and discovers rule files from `.sisyphus/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`, `AGENTS.md`, `CLAUDE.md`.

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the parameter-property patches after re-running the transform, then re-check `npm run check`. The same applies to the environment resolver (`config.ts`, `index.ts`, `rules/types.ts`), the complete-result budget plus `<project_rules>` envelope (`rules/constants.ts`, `rules/formatter.ts`), the static-selection filter, and the dynamic `DYNAMIC_CONTEXT_SCOPE` in `index.ts`. Dropping the resolver makes the documented `PI_RULES_*` values inert; dropping complete-result budgeting makes Senpi's wrapper exceed the configured limit; dropping the envelope or static-selection adaptation silently removes project rules on the `claude-agent-sdk` lane or subsequent prompts; dropping the live-context scope reintroduces repeated dynamic instructions for each distinct matching target. Re-run `test/rules-env-config.test.ts`, `test/rules-before-agent-start.test.ts`, `test/rules-dynamic-cross-target-dedup.test.ts`, and `test/claude-agent-sdk-project-instructions.test.ts` after every re-vendor.


## 2026-09-23 — Address injected project rules only to the model

### What changed

`packages/coding-agent/src/core/extensions/builtin/rules/index.ts`: Add audience model to the appended rules text part. Keep appendRuleActivation and its display-only entry unchanged. Cover truncated-rule continuation text with the same whole-part marker.

### Why

Injected instructions and their continuation notices are model context, not tool output for the user.

### Why an extension could not handle it

This built-in extension is the producer and therefore must declare the audience itself.

### Expected merge conflict zones

The single appended text-part literal after appendRuleActivation; a separate lane will add toolCallId to the unchanged activation call.

- Covered production paths: `packages/coding-agent/src/core/extensions/builtin/rules/index.ts`.
