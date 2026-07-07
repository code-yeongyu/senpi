# changes.md — websearch (vendored)

Vendored from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) at `0b9b44e83eef46121758f22965aadf59544faccf`.

## Senpi adaptations vs upstream

- Imports rewritten manually for the senpi source tree:
  - `@mariozechner/pi-tui` -> `@earendil-works/pi-tui`
  - `@mariozechner/pi-coding-agent` type/tool imports -> senpi local `../../types.ts` / `../../../types.ts`
  - relative `.js` import suffixes -> `.ts`
- No behavior changes versus upstream. The `web_search` tool is registered unconditionally; native provider search bypass remains upstream's provider-based check (`openai` / `anthropic`) so Anthropic-protocol third-party providers such as `kimi-coding` can still use the provider-backed tool.

## Conflict zones

Re-vendoring overwrites `index.ts` and the `websearch/` directory. There is no active auto-vendor script in this branch; re-vendor by copying upstream `src/index.ts` + `src/websearch/`, applying the import/suffix transforms above, then running the senpi checks.
