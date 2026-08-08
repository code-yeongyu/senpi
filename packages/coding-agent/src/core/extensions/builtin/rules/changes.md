# changes.md — rules (vendored)

Vendored from [`code-yeongyu/pi-rules`](https://github.com/code-yeongyu/pi-rules) (see `external-versions.json`).

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
- `rules/project-root.ts`: `findProjectRoot` stops the marker walk when `dirname()` stops progressing, fixing an infinite synchronous loop for targets on a different Windows drive than cwd (or UNC shares). Behavior fix also submitted upstream: https://github.com/code-yeongyu/pi-rules/pull/19 — drop this adaptation once a fixed pi-rules release is re-vendored.
- `rules/finder.ts`: `isSameOrChildPath` rejects an absolute `relative()` result via `isAbsolute()` instead of `startsWith("/")`. On Windows, `relative()` between two different drive roots returns an absolute path (`relative("C:\\proj", "D:\\other")` -> `"D:\\other"`) that starts with neither `".."` nor `"/"`, so the containment test accepted it and `getWalkDirectories` walked the other drive — collecting `AGENTS.md` / `CLAUDE.md` / `.claude/rules` from an unrelated drive as *project* rules. Matches the sibling helper in `rules/engine.ts`, which already uses `isAbsolute()`. POSIX behavior is unchanged (`isAbsolute` and `startsWith("/")` agree there). Propose upstream in `code-yeongyu/pi-rules` and drop the adaptation once a release carrying it is re-vendored.
- `rules/constants.ts` + `rules/formatter.ts`: `formatStaticBlock` wraps its output in a model-facing `<project_rules>` … `</project_rules>` envelope, and wraps that in opaque region sentinels (`PROJECT_RULES_REGION_START_MARKER` / `..._END_MARKER`). Provider lanes that rebuild the system prompt instead of forwarding senpi's composed one — the `claude-agent-sdk` builtin — need an explicitly bounded region to extract; unbounded, the block is either dropped entirely or read to end-of-string, which swallows the sections extensions registered later (`mcp`) append below it. The sentinels exist because the semantic `<project_rules>` tags cannot identify the block: surrounding prompt content this builtin does not own (context files before it, extensions appending after it) may legitimately contain them and would be extracted instead. Rule headings and bodies keep their text, except that the four marker literals are neutralized to their `&lt;…&gt;` form: a rule quoting a raw sentinel would terminate extraction early and silently drop every rule after it, while a rule quoting a raw semantic tag would corrupt the envelope structure the model reads. An extension cannot express any of this because the block is produced inside this builtin. Propose upstream in `code-yeongyu/pi-rules` and drop the adaptation once a release carrying it is re-vendored.
- `config.ts` + `index.ts` + `rules/types.ts`: back-port accepted upstream PR [`pi-rules#25`](https://github.com/code-yeongyu/pi-rules/pull/25) before a release is available. The built-in now resolves `PI_RULES_DISABLED`, `PI_RULES_MAX_RULE_CHARS`, and `PI_RULES_MAX_RESULT_CHARS` when its factory runs; integer limits require a whole-string positive safe integer, and the presence-only disable flag composes with the environment baseline instead of overwriting it with its registered `false` default on the first hook. This cannot be supplied by another extension because the engine config and flag synchronization are private to this builtin. Drop the manual back-port when `external-versions.json` can pin a pi-rules release containing merge commit `12ad906f0b29e949ebbd1f89d8f85789578aa6e6`.
- `rules/formatter.ts`: Senpi's extra semantic envelope, opaque sentinels, headings, absolute source headers, and separators are included in `maxResultChars`. Upstream budgets only rule bodies because it does not carry this Senpi-specific wrapper; without the adjustment, `PI_RULES_MAX_RESULT_CHARS=300` still produced a 547-character static block and a computed 600-character dynamic budget produced 893 characters. The formatter now subtracts observed formatting overhead and re-renders until the complete static or dynamic block fits, returning no empty envelope when the budget cannot hold one valid rule. An extension cannot fix this after the fact because the over-budget block has already been produced and inserted by this builtin.
- `index.ts`: `before_agent_start` no longer gates static rule selection on `engine.isStaticInjected(rule)`. The host re-emits that event from the BASE system prompt on every user prompt (`core/agent-session.ts`), so a mark written on turn 1 removed the block from turn 2 onward — on every provider, not just the SDK lane. The marks are still written; they now serve only the dynamic `tool_result` path's dedup. Same upstream-proposal note as above.
- Otherwise, behavior is unchanged. Registers `/rules` and `/reload-rules` and discovers rule files from `.sisyphus/rules`, `.claude/rules`, `.cursor/rules`, `.github/instructions`, `AGENTS.md`, `CLAUDE.md`.

## Conflict zones

Re-vendoring overwrites these files; this is a MANUAL_PACKAGES entry in `scripts/sync-builtin-extensions.mjs` (metadata only, no auto file-sync). Re-apply the parameter-property patches after re-running the transform, then re-check `npm run check`. The same applies to the environment resolver (`config.ts`, `index.ts`, `rules/types.ts`), the complete-result budget plus `<project_rules>` envelope (`rules/constants.ts`, `rules/formatter.ts`), the static-selection filter, and the dynamic `DYNAMIC_CONTEXT_SCOPE` in `index.ts`. Dropping the resolver makes the documented `PI_RULES_*` values inert; dropping complete-result budgeting makes Senpi's wrapper exceed the configured limit; dropping the envelope or static-selection adaptation silently removes project rules on the `claude-agent-sdk` lane or subsequent prompts; dropping the live-context scope reintroduces repeated dynamic instructions for each distinct matching target. Re-run `test/rules-env-config.test.ts`, `test/rules-before-agent-start.test.ts`, `test/rules-dynamic-cross-target-dedup.test.ts`, and `test/claude-agent-sdk-project-instructions.test.ts` after every re-vendor.
