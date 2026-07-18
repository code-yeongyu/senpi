# changes.md — websearch (vendored)

Vendored from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) at `06e3ec457e86d299c20808954e18f20b23cc7a64`.

## Senpi adaptations vs upstream

- Imports rewritten manually for the senpi source tree:
  - `@mariozechner/pi-tui` -> `@earendil-works/pi-tui`
  - `@mariozechner/pi-coding-agent` type/tool imports -> senpi local `../../types.ts` / `../../../types.ts`
  - relative `.js` import suffixes -> `.ts`
- Senpi forwards the tool `AbortSignal` into native route discovery so cancellation stops waiting for pending authentication before any provider request begins, and canonicalizes one permitted terminal DNS dot in route identity so dotted and undotted aliases share one candidate.
- `index.ts` diverges from upstream's provider-name bypass (`provider === "openai" || provider === "anthropic"`): the `provider_native_bypass` state is instead gated on `supportsNativeAnthropicWebSearch` / `supportsNativeOpenAiWebSearch` (+ their enable envs) from the sibling `anthropic-web-search` / `openai-web-search` builtins, and recomputed on `model_select`. Upstream's check disabled the standalone `web_search` tool for any model whose provider id is `anthropic`/`openai`, including proxied baseUrls (ccapi, quotio, …) where the injecting builtins never add the server-side tool — leaving those sessions with no web search at all, and leaving a stale bypass after mid-session model switches. Covered by `test/suite/websearch-extension-bypass.test.ts`.

## Conflict zones

Re-vendoring overwrites `index.ts` and the `websearch/` directory. There is no active auto-vendor script in this branch; re-vendor by copying upstream `src/index.ts` + `src/websearch/`, applying the import/suffix transforms above, then running the senpi checks.
