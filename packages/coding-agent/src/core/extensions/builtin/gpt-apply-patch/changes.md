# changes

## 2026-10-03 - Pin pi-apply-patch 0.1.4

Upstream 0.1.4 carries three changes. The indented-header fix (pi-apply-patch#46) is ported by #2637, and the line-ending fix (pi-apply-patch#48) is ported here (#2638). The `constrainedSampling` grammar declaration (pi-apply-patch#43) needs no port: senpi already sends the Lark grammar natively (`tool.ts` `freeform`). Only `external-versions.json` changes for the pin.

## 2026-10-03 - Preserve line endings on update (#2638)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/line-endings.ts` (new): `SourceText` parses a file into lines that keep their own ending (`\r\n`, `\n`, lone `\r`). `replace` rewrites only the replaced lines, giving inserted lines the file's first ending. `replacementsAroundContext` splits a matched chunk around its context lines so they stay untouched.
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/patch-replace.ts`: `replaceChunks` works on `SourceText` instead of an LF-normalized line array.
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/parser.ts`, `streaming-parser.ts`, `types.ts`: each chunk records `contextLineIndices`.

### Why

- Every update rewrote the whole file with LF, so a one-line change to a CRLF or mixed-ending file became a whole-file diff (Codex scenarios `023`/`024` failed). This is Codex's PreserveLineEndings model.

### Why an extension could not handle it

- The replace path is this builtin's own apply engine.

### Expected merge conflict zones

- LOW: `patch-replace.ts` `replaceChunks`; `parser.ts` `parseChunkLines`; `types.ts` `PatchChunk`.

## 2026-10-03 - Reject stray lines between file sections; shared header parsing (#2636)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/text.ts`: adds `parseFileHeader` (trim, then match the Add/Delete/Update marker) and `parseMoveTo` (trim end, as Codex does). `extractPatchedPaths` now lists paths through those two functions instead of its own regex.
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/parser.ts`: reads file headers through `parseFileHeader`/`parseMoveTo`, skips blank lines between sections, and rejects any other line there with `is not a valid hunk header` instead of skipping it.

### Why

- An indented file header was skipped together with its hunk lines while the patch reported success, so the model believed an edit happened that never did (Codex scenario `017_whitespace_padded_hunk_header` failed).
- The permission system takes per-file approval paths from `extractPatchedPaths`. Sharing one header parser keeps the approved paths equal to the written paths for any whitespace padding.

### Why an extension could not handle it

- The parser and the path extractor are this builtin's own grammar; nothing outside it can change how a patch is read.

### Expected merge conflict zones

- LOW: `parser.ts` top-level section loop and `parseAddHunk`/`parseUpdateHunk` signatures; `text.ts` `extractPatchedPaths`.
## 2026-09-24 - Pin pi-apply-patch 0.1.3, no port needed (senpi#2079)

Every `src/index.ts` change between 0.1.2 and 0.1.3 is already in senpi's multi-file port: custom Responses API gating (`extension.ts`, broader than upstream's provider list), paths outside cwd (`workspace.ts`), final diff preview in result details (`tool.ts`), per-file mutation queues (`apply.ts`), and failure codes with `failedFiles` / reread classification (`recovery.ts`, `types.ts`). The sync report's single hunk is the whole upstream monolith against senpi's barrel `index.ts`. Only `external-versions.json` changes.

## 2026-09-21 - Recognize provider-prefixed GPT model ids (#1891)

### What changed

- `extension.ts`: recognizes GPT family segments after provider delimiters, case-insensitively, while preserving the existing API-specific JSON/freeform gate.

### Why

- Prefixes such as `codex/gpt-6-astra` already selected a GPT prompt but left its patch tool inactive. The regression covers preset agreement, model switches, lazy activation and real patch execution.

### Why an extension could not handle it

- This builtin owns the activation predicate and tool variant; another extension cannot safely override its decision.

### Expected merge conflict zones

- LOW: `extension.ts` model-id predicate.

## Binary-safe patch previews (2026-08-05)

### What changed

- `preview.ts`: reads source and move-destination snapshots as bytes, classifies NUL-containing or invalid-UTF-8 files
  as binary before constructing any line or unified diff, and carries that typed marker through pending and completed
  previews.
- `apply.ts`: deletion and update/move results reuse the same byte-aware snapshot. Move-only binary patches preserve
  the original bytes atomically, while text hunks against binary sources fail instead of decoding and rewriting them.
- `preview-format.ts` / `types.ts`: binary files render as a concise `(binary)` summary with no diff, patch payload, or
  synthetic line counts.

### Why

Deleting an accidental PNG with `apply_patch` decoded the image as UTF-8, built a normal line diff containing `�PNG`,
NUL/control bytes, `IHDR`, and `IDAT`, then rendered that payload inside the live TUI card. Character/line truncation
bounded the size but did not make binary content safe.

### Why this belongs in the extension

The builtin owns the source snapshot, preview metadata, persisted result details, and custom renderer. Fixing the
shared differential renderer would only hide one consumer while leaving poisoned binary diffs in session and
app-server result data.

### Expected upstream conflict zones

- LOW: `preview.ts` snapshot decoding and binary preview construction.
- LOW: `apply.ts` delete-source snapshot reuse.
- LOW: `preview-format.ts` per-file summary formatting and `types.ts` preview metadata.

## Codemode lazy activation (2026-08-04)

### What changed

- `extension.ts`: tracks the current apply-patch wire mode and registers an extension-owned lazy activator. When codemode requests the already-registered `apply_patch` tool through `executeTool(..., { activateInactiveTool: true })`, the activator adds it to the live tool set only for eligible GPT/OpenAI wire modes.
- `types.ts`: the narrow apply-patch extension API accepts the runtime's lazy-activator registration hook while remaining usable by isolated extension stubs that do not provide it.

### Why

The apply-patch extension deliberately preserves an active tool set that contains neither `edit` nor `write`, so `apply_patch` can remain registered but inactive. Codemode exposes registered extension tool schemas and asks the owning extension to authorize lazy activation, but apply-patch did not register that authorization. Eval calls therefore failed with `Tool apply_patch is registered but inactive` even on eligible GPT/OpenAI models.

### Why this belongs in the extension

Inactive-tool eligibility is intentionally owned by the registering extension. A core fallback that activates every registered tool would bypass permission, tombstone, model-gating, and user-selection policies. The apply-patch extension can safely decide eligibility from its current wire mode without changing generic tool-registry behavior.

### Expected upstream conflict zones

- `extension.ts`: apply-patch model/session toolset synchronization, local state shape, and event registration order.
- `types.ts`: the narrowed `ApplyPatchExtensionAPI` surface.

## Compact completed result retention (2026-08-02)

### What changed

- `tool.ts`: completed previews persist `truncatePreview()` output and retain a complete unified `patch` only when it is at most 16 KiB per file; oversized patches are omitted instead of retaining source-sized bodies or producing malformed truncations.
- `index.ts`: the public barrel exports `APPLY_PATCH_RESULT_PATCH_MAX_BYTES` alongside the tool factory and preview limits so retention-contract tests share the production budget.
- `apply.ts`: pure result compaction uses destructuring omission so nested applied operations keep indexes and preview metadata, including future optional fields, while dropping full patch bodies and emptying diffs. The fail-fast `ApplyPatchError` path uses the same compaction.
- Regression coverage uses a 3,000-line fixture to cap serialized completed details below half the per-file patch budget. App-server projection tests pin complete diffs within budget and an empty projection when a patch exceeds it.

### Why

- After visible-diff and nested-operation compaction, `preview.files[].patch` still contained both old and new file contents and accounted for effectively all retained bytes on large updates, additions, and deletions.
- App-server projection runs from the same result object later copied into the persisted tool-result message. There is no builtin-extension seam after projection but before persistence, so a documented fixed budget is the smallest safe retention boundary; omission is preferable to an invalid partial unified diff.

### Why extension system couldn't handle this

- The source-backed patch payload is assembled by the builtin tool before both app-server projection and session persistence.

### Expected merge conflict zones

- LOW: `apply.ts` result compaction and `tool.ts` completed-preview construction.

## Failed apply_patch outcomes are explicit errors (2026-07-31)

### What changed

- `extension.ts`: completed `apply_patch` results with one or more failed operations now set the tool-result
  `isError` flag, including partial successes where earlier file actions were already applied.
- `tool.ts`: failed results render an error-background card titled `Patch failed` or
  `Patch partially failed`, preserving both any successful diff preview and the recovery text.
- Tests cover the model-facing error flag plus complete- and partial-failure TUI output.

### Why

- A failed operation was returned as a successful tool result, so the model did not receive an error signal.
- The custom TUI renderer hid the failure text and could leave a completed failure labeled `Applying patch`.

### Why extension system couldn't handle this

- The error classification and renderer belong to the builtin `apply_patch` extension itself; no core agent-loop or
  TUI change is required.

### Expected merge conflict zones

- LOW: `extension.ts` result-hook registration and `tool.ts` completed-result rendering.

## Source-backed apply_patch result patches (2026-07-21)

### What changed

- `preview.ts` / `types.ts` / `apply.ts`: each successful sequential operation records its source-order index and the
  source-backed preview built from the filesystem state immediately before that operation. Move previews use an
  applicable delete-source plus add/update-destination patch.
- `tool.ts`: completed previews are rebuilt from those successful operation records instead of destination-path matches.

### Why

- App-server clients consume mutation result details as unified diffs. Display rows were not parseable patches,
  multi-file results lacked delimiters, partial success dropped successful changes, and move-only operations were empty.

### Why extension system couldn't handle this

- This builtin owns the per-operation source snapshot and final application result needed to preserve an honest patch
  contract when several actions share a path or depend on earlier actions.

### Expected merge conflict zones

- LOW: preview construction and execute-result details in `preview.ts` / `apply.ts` / `tool.ts`.

## Capability-driven dual-variant exposure (2026-07-19)

### What changed

- `extension.ts`: replaced the Responses-only gate with `getApplyPatchWireMode(model)` ->
  `freeform | json | none`. Responses-family `gpt-*` models keep the freeform variant;
  `gpt-*` models on `openai-completions` now receive apply_patch as a plain JSON function
  tool; every other API and non-`gpt-*` id keeps `edit`/`write`.
- `tool.ts`/`constants.ts`/`types.ts`: `createApplyPatchTool(variant)` produces a JSON
  variant (`APPLY_PATCH_JSON_DESCRIPTION`, no `freeform`) alongside the freeform default.
- The toolset swap now records exactly which edit-family tools it removed and restores
  only that owned set on switch-back (composition-safe; MCP promotions and deliberate
  disables survive round trips).

### Why

- `gpt-*` models served through OpenAI-compatible proxies on `openai-completions` never
  received apply_patch. The documented Completions restriction is deliberately superseded:
  apply_patch is exposed there as a JSON function tool, mirroring the oh-my-pi reference.

## Responses-family API gate (2026-06-10)

### What changed

- `extension.ts`: apply_patch activation is gated on Responses-family APIs (`openai-responses`,
  `azure-openai-responses`, Codex Responses) instead of a provider-name allowlist (`openai`,
  `azure-openai-responses`, `github-copilot`).

### Why

- The provider allowlist missed OpenAI-compatible custom providers that serve `gpt-*` models via
  `openai-responses`, and would have crashed on Copilot `gpt-4.1`: it runs on `openai-completions`, which throws on
  freeform tools.

### Why extension system couldn't handle this

- Activation policy is this builtin's own logic over the active model's API metadata.

### Expected merge conflict zones

- LOW: `extension.ts` activation predicate.

## Live apply_patch stream rendering (2026-05-27)

### What changed

- `streaming-render.ts`: partial apply_patch tool-call arguments render as a live-updating preview while the model
  streams the patch, instead of waiting for the complete call.

### Why

- Large patches streamed for many seconds with no visual feedback.

### Why extension system couldn't handle this

- Streaming render belongs to this builtin's renderer surface.

### Expected merge conflict zones

- LOW: `streaming-render.ts`; regression at `test/suite/regressions/tui-apply-patch-rendering.test.ts`.

## Shared rich diff rendering (2026-05-17)

### What changed

- `preview-format.ts`: apply_patch previews render through the shared core diff renderer
  (`core/tools/diff-render.ts`, see `core/tools/changes.md` 2026-05-17) so edit, write, and apply_patch share row
  backgrounds, line numbers, syntax highlighting, and inline change emphasis.

### Why

- File-mutation tools rendered diffs three different ways.

### Why extension system couldn't handle this

- The builtin's renderer had to adopt the shared core renderer; the shared renderer itself lives in `core/tools/`.

### Expected merge conflict zones

- LOW: `preview-format.ts` render pipeline.

## Hunk-centered large diff previews (2026-05-12)

### What changed

- `preview-format.ts`: Large apply_patch previews now truncate around the first changed hunk instead of showing only the file head and tail, while still enforcing the configured preview line and character caps.

### Why

- Large file edits could render line-count summaries like `(+2 -0)` while hiding the actual added or removed lines, making the TUI preview misleading.

### Why extension system couldn't handle this

- The behavior belongs to this builtin extension's renderer and the vendored `pi-apply-patch` source that generates the preview text.

### Expected merge conflict zones

- LOW: `preview-format.ts` around `truncatePreview()` when refreshing the vendored apply_patch renderer.

## 2026-10-03 - Bounded, incremental apply_patch streaming render (senpi#2656)

### What changed

`streaming-parser.ts`: `pushDelta` returns the parser's live hunk list (no per-delta `structuredClone`; `finish()` still returns a defensive clone) and adds `getLiveHunks()` / `getPartialLine()` for the render path. `streaming-render.ts`: the streaming box is tail-windowed to 12 lines per file with a sticky per-file header carrying net `(+a -d)` counts (real changes only — unchanged context lines are excluded) and a `… (+N lines above)` marker when a file outgrows the window; the in-flight partial line renders dimmed as the last row; a delta that produces no new visible text keeps the already-rendered box instead of rebuilding or blanking it. `types.ts`: the streaming render state carries the non-cloning accessors, the render key, and a readonly hunk list.

### Why

The streaming box had no height bound and re-parsed plus re-rendered the whole body on every delta, with a per-delta `structuredClone` over every hunk — about 3x the CPU of the comparison TUI, and at 13 s only the first of three files was visible. A bounded, sticky-header box plus incremental, clone-free rendering keeps the stream readable and cuts the per-delta work.

### Why an extension could not handle it

The streaming parser and renderer are internal to this builtin's tool surface; the per-delta clone and the unbounded box are not reachable through the public extension API.


### Covered production paths

- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/streaming-render.ts`
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/streaming-parser.ts`
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/parser.ts`
- `packages/coding-agent/src/core/extensions/builtin/gpt-apply-patch/types.ts`

### Expected merge conflict zones

Upstream edits to `streaming-parser.ts` or `streaming-render.ts` at the next sync.
