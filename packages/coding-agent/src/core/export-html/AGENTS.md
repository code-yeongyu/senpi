# packages/coding-agent/src/core/export-html

Self-contained HTML session export (`/export`): renders a session JSONL file plus its system prompt and tool metadata into one styled HTML document. Isolated from the agent loop — `agent-session.ts` calls in through `exportSessionToHtml` only.

## FILES

| File | Role |
|---|---|
| `index.ts` | `exportSessionToHtml(sm, state?, options?)` (live-session export) and `exportFromFile(inputPath, …)` (standalone CLI export of arbitrary `.jsonl`); default output `<app>-session-<basename>.html` |
| `ansi-to-html.ts` | Terminal ANSI → HTML conversion for tool output |
| `tool-renderer.ts` | Support for the `ToolHtmlRenderer` seam — custom tool calls/results collapsed into HTML fragments |
| `template.html` / `template.css` / `template.js` | Exported page shell: self-contained viewer with collapsible tool calls and syntax highlighting |
| `vendor/highlight.min.js`, `vendor/marked.min.js` | Vendored highlight.js + marked, shipped as-is |

## WHERE TO LOOK

| Task | File |
|---|---|
| Change export output/wiring | `index.ts` |
| Change terminal-output rendering fidelity | `ansi-to-html.ts` |
| Change how extension tools appear | `tool-renderer.ts` + the `ToolHtmlRenderer` implementation in `agent-session.ts` |
| Change viewer styling/behavior | `template.*` (assets, not TS) |

## CONVENTIONS

- Custom tool rendering goes through the `ToolHtmlRenderer` seam: `agent-session.ts` pre-renders extension tools (`renderCall` / `renderResult`) so export never imports tool code.
- Theme colors resolve through `modes/interactive/theme` (`getThemeExportColors`); the template directory resolves through `config.ts` `getExportTemplateDir`.
- Output naming uses `APP_NAME` branding (`senpi-session-…`); `outputPath` supports `~` expansion and path normalization.
- In-memory sessions cannot export — the guard requires an existing session file; preserve it.

## ANTI-PATTERNS

- Hand-editing `vendor/*.min.js` — vendored assets ship byte-for-byte; upgrade by re-vendoring.
- Interpolating entry content into the template without escaping — escaping is owned here, not by callers.
- Adding a markdown/syntax-highlight dependency — marked and highlight.js are vendored on purpose (offline, zero install).
