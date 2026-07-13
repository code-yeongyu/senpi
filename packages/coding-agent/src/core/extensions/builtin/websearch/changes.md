# changes.md — websearch (vendored)

Vendored from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) at `06e3ec457e86d299c20808954e18f20b23cc7a64`.

## Senpi adaptations vs upstream

- Imports rewritten manually for the senpi source tree:
  - `@mariozechner/pi-tui` -> `@earendil-works/pi-tui`
  - `@mariozechner/pi-coding-agent` type/tool imports -> senpi local `../../types.ts` / `../../../types.ts`
  - relative `.js` import suffixes -> `.ts`
- Senpi forwards the tool `AbortSignal` into native route discovery so cancellation stops waiting for pending authentication before any provider request begins. Otherwise behavior matches upstream: the `web_search` tool is registered unconditionally, and native provider search bypass remains upstream's provider-based check (`openai` / `anthropic`) so Anthropic-protocol third-party providers such as `kimi-coding` can still use the provider-backed tool.

## Conflict zones

Re-vendoring overwrites `index.ts` and the `websearch/` directory. There is no active auto-vendor script in this branch; re-vendor by copying upstream `src/index.ts` + `src/websearch/`, applying the import/suffix transforms above, then running the senpi checks.
