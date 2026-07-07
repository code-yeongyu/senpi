# changes

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
