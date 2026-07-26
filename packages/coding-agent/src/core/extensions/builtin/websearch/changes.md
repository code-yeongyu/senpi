# changes.md — websearch (vendored)

Vendored from [`code-yeongyu/pi-websearch`](https://github.com/code-yeongyu/pi-websearch) at `7fb28c31623bafb77f437095d57315c26f202dc2` (0.3.0).

## Senpi adaptations vs upstream

- Imports rewritten manually for the senpi source tree:
  - `@earendil-works/pi-coding-agent` public imports (`defineTool`, `ExtensionAPI`/`ExtensionContext` types) -> senpi-local `../../types.ts` / `../../../types.ts`
  - relative `.js` import suffixes -> `.ts`
  - the `@earendil-works/pi-tui` import is identical in both trees and needs no rewrite
- Senpi forwards the tool `AbortSignal` into native route discovery (`buildNativeEntries(model, registry, signal)` and the `configWithNativeRoute` call in `tool.ts`) so cancellation stops waiting for pending authentication before any provider request begins. Not upstream as of 0.3.0.
- `nativeRouteKey` additionally strips one permitted terminal DNS dot from the hostname before hashing, so `host.` and `host` collapse to one discovered candidate. The hashed `provider|endpoint` route key itself is upstream. Covered by `test/websearch-native-route-dedup.test.ts`.
- `index.ts` diverges from upstream's provider-name bypass (`provider === "openai" || provider === "anthropic"`): the `provider_native_bypass` state is instead gated on `supportsNativeAnthropicWebSearch` / `supportsNativeOpenAiWebSearch` (+ their enable envs) from the sibling `anthropic-web-search` / `openai-web-search` builtins, and recomputed on `model_select`. Upstream's check disabled the standalone `web_search` tool for any model whose provider id is `anthropic`/`openai`, including proxied baseUrls (ccapi, quotio, …) where the injecting builtins never add the server-side tool — leaving those sessions with no web search at all, and leaving a stale bypass after mid-session model switches. Covered by `test/suite/websearch-extension-bypass.test.ts`.
- `config.ts` reads senpi's own config dir (`CONFIG_DIR_NAME` from `packages/coding-agent/src/config.ts`, resolved to `.senpi`) ahead of the legacy `.pi` directory, while keeping `.pi` as a fallback so existing users keep loading. Project `.senpi` wins over project `.pi`; both project paths win over anything in the home dir; the legacy `~/websearch.json` keeps its precedence over `~/<config dir>/websearch.json`. Covered by `test/websearch-config-paths.test.ts`.

Per-attempt search progress and the three-state route rendering landed upstream in 0.3.0 (they were previously senpi-only), so the senpi tree now mirrors that logic exactly: one shared `providerEntryLabel` (`provider/id`, discovered native ids collapsed to `provider/native`), resolved `routeLabels` on every progress update, no `[n/m]` step counter, and a `route <label>:<state>` line listing already-tried, currently-running, and pending sources when expanded. Covered by `test/websearch-progress.test.ts` and `test/websearch-native-tool.test.ts`.

## Conflict zones

Re-vendoring overwrites `index.ts` and the `websearch/` directory. There is no active auto-vendor script in this branch; re-vendor by copying upstream `src/index.ts` + `src/websearch/`, applying the import/suffix transforms above, then running the senpi checks.
