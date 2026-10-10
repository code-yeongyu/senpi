## 2026-10-10 - Venice E2EE encrypts prompts before they leave the process

### What changed

- `packages/ai/src/providers/venice.ts`: the Venice factory appends the published `e2ee-*` catalog rows models.dev does not list, and wraps the OpenAI-completions API so those model ids run the E2EE session.
- `packages/ai/src/providers/venice-e2ee.ts`: client secp256k1 ECDH, HKDF-SHA256, and AES-256-GCM seal every content-bearing message before the request is sent; the SSE and JSON bodies are decrypted locally. Attestation accepts the model signing key only when the Intel TDX quote's REPORTDATA binds that key and the client nonce and the quote is not a debug TD. This is structural binding, not Intel DCAP signature verification.
- `packages/ai/src/providers/all.ts`: `getBuiltinModel` and `getBuiltinModels` serve those same rows. The generated Venice shard does not contain them, and replacing the shard would drop the models a regeneration owns.

### Why

Venice's `include_venice_system_prompt: false` flag only changes a server-side privacy policy. Prompts were still plaintext on the wire. `e2ee-*` models require the client to encrypt to the attested TEE key and to decrypt the streamed ciphertext. Non-`e2ee-*` Venice models stay plaintext. Prices and context windows are the published E2EE listing as of 2026-10-10; `e2ee-gemma-4-26b-a4b-uncensored-p` is omitted because its max output tokens were not published. Function calling, images, and audio stay unsupported because the TEE does not decrypt those fields.

### Why an extension could not handle it

An extension sees the transcript before the provider builds the HTTP body, and it cannot replace the response stream the OpenAI client parses. Encryption has to run on the payload after message conversion, and decryption has to run on the bytes before that parser. Both sit in the provider request path.

### Expected merge conflict zones

- `packages/ai/src/providers/venice.ts` provider factory (`models` and `api`), against catalog or auth edits to the same factory.
- `packages/ai/src/providers/all.ts` built-in catalog reads (`getBuiltinModel`, `getBuiltinModels`), against provider-registration edits.
- Low: `packages/ai/src/providers/venice-e2ee.ts` is fork-owned. A later models.dev listing of these ids should drop the matching factory overlay rather than duplicate the row.

## 2026-10-09 - Restore providers-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/providers/all.ts`: builtin provider set and fork-owned provider registration surviving catalog regeneration.
- `packages/ai/src/providers/amazon-bedrock.ts`: ambient shared-cloud credential chains (senpi#2327).
- `packages/ai/src/providers/anthropic.ts`: eagerly built and exported `streamAnthropic` / `streamSimpleAnthropic` (`anthropicMessagesApi()` evaluated at module load).
- `packages/ai/src/providers/cloudflare-ai-gateway.ts`: preserved provider adapter behavior re-diverged from upstream.
- `packages/ai/src/providers/faux.ts`: faux provider test surface with bounded retry jitter and abort metadata.
- `packages/ai/src/providers/github-copilot.ts`: account-own API host, account model limits, and refused-token re-exchange (senpi#2297/#2299/#2309).
- `packages/ai/src/providers/google.ts`: eagerly built and exported `streamGoogle` / `streamSimpleGoogle` (`googleGenerativeAIApi()` evaluated at module load).
- `packages/ai/src/providers/google-vertex.ts`: eagerly built and exported `streamGoogleVertex` / `streamSimpleGoogleVertex` (`googleVertexApi()` evaluated at module load), plus Vertex ambient-ADC marking (`ambient: true`) when only gcloud application default credentials are present.
- `packages/ai/src/providers/images/register-builtins.ts`: canonical images builtin registration on the v6 model surface.
- `packages/ai/src/providers/kimi-coding.ts`: regional Kimi Code login and provider-declared retry policy profiles.
- `packages/ai/src/providers/openai-codex.ts` and `packages/ai/src/providers/openai-codex.models.ts`: DELETED in the fork — renamed to `packages/ai/src/providers/chatgpt-subscription.ts` / `.models.ts` (senpi#1989, fork rename `3c816ead49`) and kept deleted through the v0.99.1 sync. Upstream edits to these paths must stay unadopted; port applicable deltas into the `chatgpt-subscription` counterparts instead of resurrecting the files.
- `packages/ai/src/providers/openai.ts`: [OI] provider family on the v0.99.1 sync.
- `packages/ai/src/providers/openrouter.ts`: OpenRouter images on the v6 model surface.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the single file it touched, so the 14 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The module-load `stream*` / `streamSimple*` const-and-export blocks in `packages/ai/src/providers/anthropic.ts`, `packages/ai/src/providers/google.ts`, and `packages/ai/src/providers/google-vertex.ts`, against upstream edits to the same files; and the `vertexAuth` ambient-ADC return in `packages/ai/src/providers/google-vertex.ts`.
- HIGH: `packages/ai/src/providers/openai-codex.ts` and `packages/ai/src/providers/openai-codex.models.ts` are deleted in the fork but still edited upstream — a sync must not resurrect them; port applicable deltas into the `chatgpt-subscription` counterparts and keep these paths deleted.
- The provider registration and import lists in `packages/ai/src/providers/all.ts` and the images builtin registration in `packages/ai/src/providers/images/register-builtins.ts`, against provider additions or regeneration.

## 2026-10-07 - OpenGateway HTTP refresh failures retain status (senpi#2893)

### What changed

- `packages/ai/src/providers/opengateway-refresh.ts`: use the shared status-bearing HTTP error for catalog refresh failures without changing the message or last-good-catalog policy.

### Why

Refresh failure consumers need the original HTTP fact rather than message parsing.

### Why an extension could not handle it

The catalog's private fetch helper creates the failure.

### Expected merge conflict zones

- `fetchJson` in `opengateway-refresh.ts`.


## 2026-10-08 - Official Kimi K3 cache-write price

### What changed

- `packages/ai/src/providers/kimi-coding.models.ts`: the hand-kept Kimi Coding `k3` row's API-equivalent `cost.cacheWrite` 0 -> 3, matching the official K3 price it estimates from.

### Why

- The official Kimi API price list (https://platform.kimi.ai/docs/pricing/chat) bills Kimi K3 cache writes at $3 per 1M tokens for the default 5-minute TTL ($6 for 1 hour); the catalog still had them at $0, which undercounted cost on requests that write the cache and failed the 2026.10.10-8 release regeneration once upstream data caught up.

### Why an extension could not handle it

- Built-in model prices are catalog data generated or kept in this package; nothing at runtime can correct them.

### Expected merge conflict zones

- LOW: the Kimi K3 cost constants when upstream reprices Kimi models.
