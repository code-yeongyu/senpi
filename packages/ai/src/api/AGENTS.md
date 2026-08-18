# packages/ai/src/api

Generated: 2026-08-17. Commit `abae968e8`.

Provider wire protocol implementations and stream adapters. Each provider ships as a concrete module plus a `.lazy.ts` wrapper that uses `lazyApi()` from `lazy.ts`.

## MODULE PAIRS

| Concrete | Lazy wrapper |
|---|---|
| `anthropic-messages.ts` | `anthropic-messages.lazy.ts` |
| `openai-responses.ts` | `openai-responses.lazy.ts` |
| `openai-completions.ts` | `openai-completions.lazy.ts` |
| `openai-codex-responses.ts` | `openai-codex-responses.lazy.ts` |
| `cursor-agent.ts` | `cursor-agent.lazy.ts` |
| `azure-openai-responses.ts` | `azure-openai-responses.lazy.ts` |
| `google-generative-ai.ts` | `google-generative-ai.lazy.ts` |
| `google-vertex.ts` | `google-vertex.lazy.ts` |
| `bedrock-converse-stream.ts` | `bedrock-converse-stream.lazy.ts` |
| `mistral-conversations.ts` | `mistral-conversations.lazy.ts` |
| `pi-messages.ts` | `pi-messages.lazy.ts` |
| `openrouter-images.ts` | `openrouter-images.lazy.ts` |

Utility modules with no lazy wrapper: `cloudflare.ts`, `github-copilot-headers.ts`, `openai-prompt-cache.ts`, `anthropic-tool-pairs.ts` (browser-safe Anthropic tool_use/tool_result pair sanitizer; final pre-submit pass), `openai-client-auth.ts` (shared client-auth resolution from credential headers), `constrained-sampling.ts` (JSON-schema-driven constrained sampling helpers).

`cursor-agent/` subdir: `types.ts` (exec-handler contracts), `pi-args.ts` (arg translators shared with `cursor-exec-bridge.ts` in coding-agent — display blocks and executed args must stay identical), `exec-modern.ts` (wire result builders for modern exec frames), `deterministic-id.ts` (stable UUID-shape ids), and `gen/agent_pb.ts` (generated protobuf-es schema; regenerate with `buf generate` from `packages/ai/proto/cursor/agent.proto`, then `node scripts/transform-cursor-agent-proto.mjs <in> <out>`; never hand-edit). `cursor-agent.ts` is Node-only: it is reached exclusively through `cursor-agent.lazy.ts`, and the Bun binary overrides it statically via `packages/ai/src/cursor-agent-provider.ts` plus `packages/coding-agent/src/bun/register-cursor-agent.ts` (imported before any Cursor provider use).

`openai-codex-responses/` subdir: `fallback-state.ts` (WebSocket fallback state + cooldown), `reasoning.ts` (Codex reasoning summary normalizer).

## LAZY BOUNDARY

`lazy.ts` exports `lazyApi()` and `lazyStream()`. A `.lazy.ts` wrapper is the **only** sanctioned dynamic-import boundary in this package. Concrete modules use top-level imports only. `src/compat.ts` (one level up) re-exports all lazy wrappers and registers them via the api-registry.

`openai-codex-responses.ts` cannot use top-level `node:os` or `node:zlib` imports because the module loads in browser/Vite builds. It uses `process.getBuiltinModule?.("node:os")` behind a runtime check. The file carries an explicit `// NEVER convert to top-level runtime imports` comment. Keep it.

## SHARED LOGIC

- `simple-options.ts` `applyExtraBody()`: merges caller-supplied `extraBody` into a provider request, skipping keys in the provider's `reservedKeys` set. Never overwrite `model`, `messages`, `stream`, tool-call fields, or reasoning fields. Each provider declares its own `RESERVED_BODY_KEYS` set (e.g., `OPENAI_COMPLETIONS_RESERVED_BODY_KEYS`).
- `transform-messages.ts`: cross-provider message coercion (image downgrade, tool-result flattening). Returns new structures; never mutates shared message arrays. Cross-model transforms drop incompatible opaque state (provider-native content that can't round-trip). Same-model provider-native state (Anthropic signed thinking, redacted thinking blocks, encrypted web-search state) is byte-sensitive and must be preserved exactly.
- `openai-responses-shared.ts`: shared logic for both `openai-responses.ts` and `openai-codex-responses.ts`. Native
  `image_generation_call` items are structurally reconciled here (not from the installed SDK type): partial-image
  events are ignored, terminal output can backfill a missing done frame, and final base64 is aggregate-capped before
  provider-native content leaves the parser.
- `google-shared.ts`: shared logic for both `google-generative-ai.ts` and `google-vertex.ts`.

## PROVIDERSTREAMS CONTRACT

Every concrete module exports an object implementing `ProviderStreams` (`types.ts`): `stream()` and `streamSimple()`. Both must preserve usage counters, stop reasons, error events, abort behavior, and partial-JSON tool call chunks across the full response lifetime. Lazy wrappers forward these invariants transparently via `lazyStream`.

## EXPORTS

All files in this directory are wildcarded in `package.json` under the `./api/*` subpath export. Don't add internal-only helpers here; they'll leak into the public surface.

## ANTI-PATTERNS

- No ordinary dynamic imports in concrete modules; all dynamic loading goes through `.lazy.ts` wrappers.
- Don't duplicate shared conversion logic in a single adapter; put it in `simple-options.ts`, `transform-messages.ts`, `openai-responses-shared.ts`, or `google-shared.ts`.
- Don't hand-edit `src/models.generated.ts`; regenerate with `scripts/generate-models.ts`.
- Don't add top-level Node built-in imports to any module consumed in browser builds.
