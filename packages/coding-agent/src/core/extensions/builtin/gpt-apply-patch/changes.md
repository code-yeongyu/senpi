# changes

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

||||||| 9ee0c4a3e
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
