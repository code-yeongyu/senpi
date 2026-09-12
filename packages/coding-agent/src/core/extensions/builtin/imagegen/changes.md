## 2026-09-11 - Guidance follows native capability or client credentials

### What changed

- `packages/coding-agent/src/core/extensions/builtin/imagegen/index.ts` contributes the bundled skill and shared guidance when the native image-generation gate and enable predicate are active, falling back to the unchanged client credential resolver otherwise.
- Focused harness regressions load the skill for OAuth-only sessions without an image key and verify switching away or disabling native generation. The arbitration matrix's two native-without-client-credentials rows now expect guidance and skill availability; other surface contracts remain unchanged.

### Why

- `packages/coding-agent/src/core/extensions/builtin/imagegen/index.ts` withheld guidance from native-capable sessions that did not have separate image API credentials.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/imagegen/index.ts` owns the bundled resource contribution and reuses the native builtin's existing gate rather than duplicating transport or credential policy.

### Expected merge conflict zones

- LOW: imports and the shared availability predicate in `packages/coding-agent/src/core/extensions/builtin/imagegen/index.ts`.

## 2026-09-10 - Sunburst stays the default model

### What changed

- `params.ts`: `DEFAULT_IMAGE_MODEL` is `gpt-image-2.5-sunburst` again, and the `model` description leads with Sunburst as the most capable option while Flare is presented as the speed trade-off. `tool.ts` description, `skill/SKILL.md` model selection, and `packages/coding-agent/docs/skills.md` say the same. `openai-image-gen/inject.ts` pins the native server tool to the same constant, so both surfaces move together.

### Why

- The earlier flip to Flare followed OpenAI's "default choice for most applications" line, but the owner's standing preference is the best available model unless speed is the stated goal; Sunburst is the base model optimized for quality (higher than gpt-image-2) while Flare is the small model with quality merely comparable to gpt-image-2.

### Why an extension could not handle it

- The default is a constant inside the owning builtin, shared with the native injector.

### Expected merge conflict zones

- LOW: the single constant plus four copy blocks.

## 2026-09-10 - Output options, masks, Flare default, and catalog pricing

### What changed

- `params.ts`: schema adds `background`, `output_format`, `output_compression`, `moderation`, and `mask_image_path`; `DEFAULT_IMAGE_MODEL` moved to `gpt-image-2.5-flare` (reverted to `gpt-image-2.5-sunburst` the same day, see the entry above); `GenerateImageDetails` gains `background`, `outputFormat`, and `transparentBackground`.
- `paths.ts`: `resolveTargets` derives the extension from the format (`.png`, `.jpg`/`.jpeg`, `.webp`), rejects mismatches, and `withFormatExtension`/`outputFormatOf` rename a target when the provider returns a different container than requested.
- `reference-images.ts`: `loadMaskImage` reuses the reference loader and requires at least one reference.
- `tool.ts`: validates output options through `parseOpenAIImageOutputOptions` before any request, forwards them to pi-ai, takes `cost` from `getImageModel("openai", id)`, labels result blocks with the returned MIME, and reports the provider's background verdict.

### Why

- GPT Image 2.5 exposes transparency, container, compression, moderation, and inpainting controls the tool did not surface; OpenAI names Flare the default for most applications; usage cost was hard-coded to zero; and a live Quotio run returned png bytes for a webp request, which would have been saved as `.webp`.

### Why an extension could not handle it

- The owning builtin's schema, validation, file naming, and result shape must change together.

### Expected merge conflict zones

- MEDIUM: `tool.ts` execute path; LOW: `params.ts`, `paths.ts`, `reference-images.ts`, tests, `skill/SKILL.md`.

# changes

## 2026-09-09 - GPT Image 2.5 generation and reference-image editing

### What changed

- `packages/coding-agent/src/core/extensions/builtin/imagegen/params.ts` owns the tool schema, result details, and structured failures. Model selection defaults to GPT Image 2.5 Sunburst, with Flare and legacy GPT Image 2 available; quality adds xhigh/max and size accepts validated custom dimensions.
- `packages/coding-agent/src/core/extensions/builtin/imagegen/reference-images.ts` resolves 1-5 local reference files, checks regular-file status, the 50 MB limit, and PNG/JPEG/WEBP signatures, and encodes them for the existing images provider.
- `packages/coding-agent/src/core/extensions/builtin/imagegen/tool.ts` validates sizes through pi-ai, passes references after the text input, and reports the selected model on success and failure. Auth, native bypass, and exclusive PNG output writes remain unchanged.
- `skill/SKILL.md` retains the prompt-crafting guide and adds model, quality, size, and end-state editing guidance. `test/imagegen-tool-2-5.test.ts` exercises provider dispatch and local validation; existing test fixture boilerplate is reduced to meet the 250-line cap without removing coverage.

### Why

- GPT Image 2.5 exposes higher quality tiers, custom resolutions, and reference-guided editing that the old fixed-model, text-only tool could not request.

### Why an extension could not handle it

- This is the owning builtin extension: its schema, input validation, model synthesis, and bundled skill must change together. The pi-ai provider already owns endpoint selection and the pinned SDK compatibility widening.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/extensions/builtin/imagegen/tool.ts` schema extraction and execute path.
- LOW: new `params.ts` and `reference-images.ts`, the bundled skill, and focused imagegen tests.

## Placeholder credentials no longer hijack image-generation auth (2026-09-04)

### What changed

- `auth.ts` treats a `SK-SENTINEL-DO-NOT-LOG*` value as absent rather than as a credential, in both the stored-`openai` branch (`credentialParts`) and the `OPENAI_API_KEY` env branch. Resolution falls through to the gateway chain, and with no gateway the tool reports "not configured" instead of pinning `api.openai.com`.

### Why

- `~/.omo/agent/auth.json` on Jobdori carries seeded placeholders `SK-SENTINEL-DO-NOT-LOG-1/-2`. The `-2` entry sits under provider `openai`, so step 1 of the chain accepted it, pinned `https://api.openai.com/v1`, and every `gpt-image-2` request answered 401 `Incorrect API key provided: SK-SENTI***OG-2` while a healthy Quotio gateway (`openai-quotio`, verified 200 + real PNG) sat unused. Reported twice on 2026-09-04; the same symptom was "fixed" on 2026-08-21 by deleting the entry, and it came back.
- Deleting the entry is not a fix: a placeholder is not a credential, and the resolver is the only place that can tell the difference before a request is sent.

### Why this cannot be expressed externally

- The chain runs inside the builtin extension before any request; a caller cannot distinguish "stored openai key" from "stored placeholder" without duplicating the resolver.

# imagegen builtin — changes

## Bun-compiled skill asset (2026-08-27)

### What changed

- Bun-compiled binaries now resolve the bundled skill through a file-asset import, while Node continues using the copied adjacent skill file.

### Why

- The skill is copied into `dist` for Node execution but was not embedded in the Bun compile graph, leaving compiled binaries without imagegen guidance.

### Why an extension could not handle it

- The skill path is resolved inside the builtin's resource-discovery handler, so no downstream extension can restore an asset absent from the compiled module graph.

### Expected merge conflict zones

- LOW: `index.ts` asset resolution branch.


## RPC-safe missing-skill diagnostics (2026-08-27)

### What changed

- Missing bundled-skill diagnostics now route to stderr instead of stdout.
- Added regression coverage proving the notice is emitted once without writing to stdout.

### Why

- Bun-compiled RPC binaries can legitimately lack the optional skill file at the module URL. Writing that diagnostic to stdout corrupts the NDJSON RPC wire.

### Why an extension could not handle it

- The diagnostic is emitted inside the builtin extension's resource-discovery path before any downstream extension can redirect the stream.

### Expected merge conflict zones

- LOW: `index.ts` missing-skill branch and `test/imagegen-skill-gating.test.ts` diagnostic assertions.


## 2026-08-13 - Materialize nullable headers only at image requests

### What changed

- Image credential resolution accepts registry `ProviderHeaders`; `null` entries are filtered only when the
  generated-image fetch request needs concrete string headers.

### Why

- Upstream header composition uses `null` as an explicit deletion marker. Narrowing the registry result earlier
  broke the merged type contract and risked retaining an inherited header.

### Why an extension could not handle it

- The imagegen builtin owns the credential-to-request conversion; no outside hook can repair a marker discarded
  before its fetch boundary.

### Expected merge-conflict zones

- LOW: `auth.ts` registry result and resolved auth types; LOW: `tool.ts` final header materialization.

## Cross-layer arbitration regression suite (2026-08-11)

### What changed

- Added `test/suite/regressions/imagegen-arbitration.test.ts`: a 23-row truth-table regression covering the full matrix of (credentials: none | gateway | native) × (model: official-responses | proxied-responses | official+compat-off | proxied+compat-on | azure | completions) × (enable-env: on | off). Each row asserts all three consumers — native injector (payload tools), client tool (execute behavior), and skill contribution (resources_discover + before_agent_start section) — agree on the active image-generation surface.
- Includes four summary invariant checks (bypass ⟺ native injection ⟺ native section; skill ⟺ creds; no-creds-no-native → missing_config; creds-no-native → live) and a gate-function discrimination test.
- Mutation proof: flipping `supportsNativeOpenAiImageGeneration` to constant true causes 12 of 28 tests to fail (captured to `w3/t12-mutation-red.txt`); reverting restores all 28 green.

### Why

- The three consumers are wired by separate builtins (imagegen and openai-image-gen) that share state through a narrow seam (`setNativeBypass` + `resolveImageGenAuth`). A regression in one builtin's gate could silently desynchronize them. This truth table locks the invariant so any mutation is caught.

### Merge-conflict zones

- NONE: test file only; no production code changed.

## Native bypass wiring goes live (2026-08-11)

### What changed

- The `setNativeBypass` seam in `state.ts` is now driven by the sibling `openai-image-gen` builtin: it recomputes the arbitration state on `session_start` and `model_select` (both flip directions) and clears the bypass on `session_shutdown`. While the current model will receive the native `image_generation` server tool, `generate_image` execute returns the `provider_native_bypass` deferral; otherwise it runs normally.
- No imagegen module code changed; only the previously inert seam gained its live caller.

### Why

- The bypass must track the injector's real decision per model, not a startup snapshot, so mid-session model switches re-arm or defer the client tool correctly.

### Merge-conflict zones

- LOW: this `changes.md` entry only; the live wiring lives entirely in `openai-image-gen`.

## Conditional skill contribution and packaging (2026-08-11)

### What changed

- Added the imagegen extension entry. It registers `generate_image` once, contributes the bundled `gpt-image-gen` skill only while `resolveImageGenAuth` finds credentials, and appends a short conditional-safe image-generation section before an agent turn while that same gate is active.
- Skill discovery resolves `skill/SKILL.md` beside the extension module and checks the file before returning it. A missing packaged asset emits one debug message and contributes no dangling path, so skill loading remains nonfatal.
- Registered the imagegen factory in the builtin catalog so the real CLI loads the tool and resource handlers.
- Extended source-build asset copying, binary-distribution asset copying, and Bun compile preparation so `builtin/imagegen/skill/SKILL.md` is present under the built extension directory.

### Why

- Tool registration, skill visibility, and prompt guidance must share one credential predicate: no credentials means no skill or image-generation section, while native OpenAI and compatible gateway credentials enable both.
- Markdown is not emitted by TypeScript compilation, so every packaging route must carry the skill explicitly rather than relying on its presence in `src`.

### Test seam note

- `registerImageGenExtension` accepts an alternate base directory so the missing-file guard can be exercised through the real `resources_discover` runner surface without renaming the checked-in skill.

### Merge-conflict zones

- LOW: `index.ts` is the isolated imagegen extension entry owned by this change.
- MEDIUM: builtin registration and package build scripts are shared catalogs; preserve sibling registrations and asset clauses when resolving conflicts.

## generate_image tool (2026-08-11)

### What changed

- Added `tool.ts` exporting `generateImageTool` (`generate_image`) plus `GENERATE_IMAGE_TOOL_NAME` and the `GenerateImageDetails` result shape. The tool is registered once and gated at call time: every execute re-resolves credentials through `resolveImageGenAuth`, so a mid-session login takes effect without a reload.
- Parameters are locked to `prompt` (1–32000 chars, blank-after-trim rejected), `size`/`quality` (`auto` unions), `n` (1–10), and an optional `output_path`, with `additionalProperties: false`. There is intentionally no `model`, `output_format`, or image-input/edit/mask surface in v1; the model is fixed to `gpt-image-2`.
- Output-path handling lives in `paths.ts`: relative paths resolve against `ctx.cwd`, an omitted path falls back to `generated-images/<sanitized tool call id>.png`, extensionless paths gain `.png`, non-`.png` extensions are rejected, and multi-image runs insert a zero-padded index before the extension. Parents are created with `mkdir -p`, existing files are never overwritten (preflight plus exclusive `wx` create), and a partial multi-image write rolls back the files that invocation already wrote.
- Results carry a text summary of saved paths, one image block per image, structured `details` (paths, model, credential `source`, size, quality, requested/generated counts, revised prompts), and provider usage when present. Key material never appears in results or logs.
- Added `state.ts` with the `native_bypass` seam (`setNativeBypass`/`isNativeBypass`, default false) that the sibling `openai-image-gen` builtin will wire live in PR-B, plus a `setImageGenRegistry` override used to force a credential direction in tests.

### Why

- The client tool must work on any OpenAI-compatible credential (native key or gateway) without a session restart, so availability is decided at execute time rather than at registration.
- Synthesizing the `gpt-image-2` image model per resolution keeps the gateway base URL and its key same-source, and threads the key through request options rather than the environment.

### Why not core

- Prompt validation, output-path policy, and file persistence are builtin behavior. Core continues to own credential interpolation; packages/ai stays browser-safe and owns no disk IO.

### Test seam note

- The builtin provider catalog always contains credential-resolvable gateways (for example github-copilot authenticates with static headers and no API key), so the ambient session registry is never credential-free. The uncredentialed direction is exercised through `setImageGenRegistry` with an empty registry rather than by mutating ambient auth.

### Merge-conflict zones

- LOW: `tool.ts`, `paths.ts`, and `state.ts` are new isolated modules; `index.ts` (the extension entry that wires them) is owned by the skill-packaging todo.
- MEDIUM: this `changes.md` receives entries from the resolver, tool, skill-gating, and native-injector lanes; preserve all dated sections when resolving concurrent additions.

## Credential-gate resolver (2026-08-11)

### What changed

- Added `auth.ts` with the pure `resolveImageGenAuth` resolver. It resolves, in order: a stored OpenAI API key, an explicitly pinned OpenAI-compatible gateway, the preferred configured gateway (`/openai/i` provider ids first, then alphabetical), and `OPENAI_API_KEY`.
- Gateway credentials resolve through the injected `ModelRegistry` surface (`getAll` plus `getApiKeyAndHeaders`) so models.json/provider auth keeps its existing environment, command, custom-header, and `authHeader` semantics. The resolver never reads `models.json` or `auth.json` directly.
- Provider model catalogs only supply a registry route for credential resolution; no image model must be listed because the client tool synthesizes the fixed `gpt-image-2` image model.

### Why

- The client tool, conditional skill, and native OpenAI injector need one credential predicate with identical precedence and fallback behavior. Centralizing it prevents a tool from appearing active while another consumer believes image generation is unavailable.
- Credentials remain same-source with their gateway base URL, so an OpenAI key cannot be combined with a third-party endpoint during fallback.

### Why not core

- Image-generation route policy, provider preference, and setup guidance are builtin behavior. Core `ModelRegistry` and auth storage remain provider-agnostic and continue owning credential interpolation and header materialization.

### Cross-builtin export intent

- `resolveImageGenAuth` is intentionally exported from `imagegen/auth.ts` for the imagegen tool/skill and the sibling `openai-image-gen` builtin. Keep the resolver pure and registry-shaped rather than moving policy into either consumer.

### Reload granularity

- Skill resources refresh at startup or explicit reload. Client-tool availability snapshots refresh at session start/model select, while every tool execution re-resolves credentials. Native injection resolves per provider request. This difference is accepted; conditional skill text must remain safe when credentials change before reload.

### Merge-conflict zones

- LOW: `auth.ts` is a new isolated module.
- MEDIUM: this `changes.md` will receive entries from the tool, skill-gating, and native-injector lanes; preserve all dated sections when resolving concurrent additions.
- NONE: this change does not edit `imagegen/skill/`, builtin registration, or packages/ai files.

## Credential-gate resolver tightening (2026-08-11)

### What changed

- `credentialParts` now requires a non-empty `apiKey`; headers alone no longer qualify a provider as an image-gen credential source.
- Headers are still threaded through when a key exists.

### Why

- Providers like `github-copilot` resolve `ok:true` with static headers and no apiKey. Those headers authenticate only their own endpoint; calling `/images/generations` there would fail confusingly. The gateway scan and `PI_IMAGE_GEN_PROVIDER` pin must require a real apiKey.

### Merge-conflict zones

- LOW: one-line guard change in `auth.ts`.
- NONE: no other modules touched.
