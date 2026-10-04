# core/tools/renderers changes

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): tools and shell utilities

### What changed

- `packages/coding-agent/src/core/tools/renderers/bash.ts`: `core/tools/renderers/bash.ts`: collapsed-preview cache holds the hint line together with the preview lines (`cachedSkipped` removed). `bash.ts`: eval-only marker `exposure: "eval"` on `createBashToolDefinition`; timeout validation; stream-callback error propagation; spill cleanup and `AggregateError` finalization; detached-group tracking (`noteDetachedChildExited`/`pruneTrackedDetachedChildren`, senpi#1697); PI_SESSION_CWD/PI_GOAL_STORE_FILE env; successful results keep the fork model-only truncation notice (`modelOnlyText`) as a separate content part.
- `packages/coding-agent/src/core/tools/renderers/read.ts`: `core/tools/renderers/read.ts` (silent merge, reviewed): null `offset`/`limit` render as omitted (strict schemas send null). `read.ts`: structural folder options, local:// guard, filesystem policy checker, model-only continuation notices.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; tools and shell utils adopt upstream bash/read fixes and keep fork output shapes and hooks (plan D-15).

### Why an extension could not handle it

Built-in tool execution and shell handling are core tool implementations that extensions call, not replace.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## Name a file inside a skill directory by its skill, senpi#2082 (2026-09-24)

### What changed

- `skill-read-path.ts` (new): `getSkillReadPath(absolutePath, cwd)` returns `<skill>/<path inside the skill>` for a file whose nearest ancestor holding `SKILL.md` is below the cwd's ancestors, the home directory, and the filesystem root; undefined otherwise. Lookups are memoized per cwd and directory.
- `read.ts`: `formatReadCall` shows that label (hyperlinked to the real file) instead of the home-shortened absolute path when the read file is inside a skill directory.

### Why

- A skill reference such as `ulw-plan/references/stance-calibration.md` rendered as its full install path under the runtime directory, hiding which skill the file belongs to; only `SKILL.md` itself was recognized.

### Why an extension could not handle it

- The read card's path text is produced inside this renderer; a read classifier replaces the whole headline with a compact card and cannot keep the ordinary `read <path>` shape.

### Expected merge conflict zones

- The `formatReadCall` body and the render-utils import line in `read.ts`.

## Export the compact read classification for the exploration group, senpi#2060 (2026-09-23)

### What changed

- `read.ts`: `getCompactReadClassification` and the `ReadRenderArgs` type are exported. The renderer's own use and its per-call memoization are unchanged.

### Why

- The interactive exploration projection needs the same `skill` / `memory` verdict the collapsed card uses, so a skill load or memory recall is not folded into the `Explored` cell.

### Why an extension could not handle it

- The classification order (`SKILL.md`, registered classifiers, docs, resource) lives in this renderer; an extension can add a classifier but cannot read the combined verdict.

### Expected merge conflict zones

- The `getCompactReadClassification` declaration in `read.ts`.

## Align grep rendering with the engine contract (2026-09-14)

### What changed

- `bash.ts`, `edit.ts`, `grep.ts`, `read.ts`, and `write.ts` render the built-in tool results; the grep renderer emits the engine-backed structured footer and grouped match format for Cursor and model-facing calls.

### Why

- Cursor and model-facing grep calls must share the new engine-backed output contract.

### Why an extension could not handle it

- Built-in renderer behavior is package code and cannot be changed by an extension.

### Expected merge conflict zones

- `packages/coding-agent/src/core/tools/renderers/*.ts`


## 2026-09-23 — Remove renderer-owned tool notice lines

### What changed

`packages/coding-agent/src/core/tools/renderers/read.ts`, `packages/coding-agent/src/core/tools/renderers/grep.ts`, `packages/coding-agent/src/core/tools/renderers/bash.ts`: Remove read truncation and oversized-line warnings, grep truncation/statistics headers, and bash full-output warnings. Remove bash footer text matching; structured audience metadata controls visibility.

### Why

The TUI must not reconstruct a notice that the producer deliberately marks model-only.

### Why an extension could not handle it

Built-in renderers own these detail-derived lines and run independently of extension-added text parts.

### Expected merge conflict zones

Read, grep, and bash result formatting; ordinary collapse hints remain.

- Covered production paths: `packages/coding-agent/src/core/tools/renderers/read.ts`, `packages/coding-agent/src/core/tools/renderers/grep.ts`, `packages/coding-agent/src/core/tools/renderers/bash.ts`.

## 2026-10-03 — Edit card header shows the aggregate change count (senpi#2653)

### What changed

`packages/coding-agent/src/core/tools/renderers/edit.ts`: the edit card header now appends a `(+a/-d)` count next to the path, derived from the preview diff via the new `countDiffChanges` in `../diff-render.ts`.

### Why

The edit card showed the path but no aggregate change size at a glance.

### Why an extension could not handle it

The edit card header is produced inside the built-in edit renderer, below the extension API.

### Expected merge conflict zones

- Covered production paths: `packages/coding-agent/src/core/tools/renderers/edit.ts`.
