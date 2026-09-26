## 2026-09-26 - Resolve embedded tree-sitter grammars under Node bundles (senpi#2032)

### What changed

- `harness/utils/read-folders/tree-sitter/grammar-assets.ts`: embedded grammar and runtime imports are now attempted on every runtime; missing or rejected imports still fall back to the installed resolver.
- `test/harness/fixtures/read-summary/selection.json`: regenerated the tracked source hash for the selection receipt.

### Why

- Published npm bundles run under Node, where the Bun-only gate previously prevented the bundled JavaScript grammar from loading and forced structural reads onto the heuristic folder.

### Why an extension could not handle it

- The runtime gate is inside the agent package's embedded asset resolver, before extensions or read-tool hooks can observe the grammar selection.

### Expected merge conflict zones

- LOW: `harness/utils/read-folders/tree-sitter/grammar-assets.ts` and the adjacent selection receipt hash.

## 2026-09-24 - Lenient tool-name matching through one shared matcher (senpi#2111)

### What changed

- `packages/agent/src/tool-name-alias.ts`: `resolveToolNameAlias` delegates to `resolveToolNameMatch` from `@earendil-works/pi-ai/utils/tool-name-match` instead of carrying its own regex and fold. It now also folds the full requested name (`MCP__srv__tool` -> `mcp__srv__Tool`), strips namespaces whose id contains underscores (`mcp__my_server__Memory` -> `memory`), and strips the namespace a registered tool carries (`create_issue` -> `mcp_github_create_issue`). It resolves only on a unique match, as before.

### Why

- The agent copy folded only the namespace-stripped suffix while the Anthropic tool-reference copy folded both the full name and the suffix. That drift is how senpi#2104 happened, and it left several plausible spellings answering `Tool <name> not found`.

### Why an extension could not handle it

- Tool-call name resolution runs inside the agent loop before any hook sees the call.

### Expected merge conflict zones

- LOW: `tool-name-alias.ts` (fork-only).

## 2026-09-24 - Strip a gateway namespace whatever the casing of its prefix (senpi#2104)

### What changed

- `packages/agent/src/tool-name-alias.ts`: `GATEWAY_TOOL_NAMESPACE` matches the `mcp__<id>__` prefix case-insensitively, so `Mcp__686f__Eval` and `MCP__686f__Eval` resolve to `eval` like `mcp__686f__Eval` already did. The unique-match rule is unchanged.

### Why

- A model carried the gateway's mixed-case tool names onto the prefix itself and called `Mcp__686f__Eval`. The lowercase-only strip left the prefix in place, the fold compared `mcp686feval` with `eval`, and the call failed with `Tool Mcp__686f__Eval not found`.

### Why an extension could not handle it

- Tool-call name resolution runs inside the agent loop before any hook sees the call.

### Expected merge conflict zones

- LOW: the `GATEWAY_TOOL_NAMESPACE` line in `tool-name-alias.ts` (fork-only).

## 2026-09-24 - Declared tools stay stable while the callable set changes (senpi#2095)

### What changed

- `packages/agent/src/types.ts`: `AgentContext.declaredTools` and `AgentState.declaredTools`, an optional superset of `tools` to declare to the provider.
- `packages/agent/src/agent.ts`: the initial state and `createContextSnapshot` carry `declaredTools`; `Agent.buildProviderContext` passes the current model.
- `packages/agent/src/agent-loop.ts`: `buildProviderContext` takes an optional model. When the context has `declaredTools` and the model passes `supportsAllowedToolChoice`, the provider context gets the declared tools (plus any active tool missing from them) as `tools` and the active names as `activeToolNames`; otherwise it gets the active tools exactly as before. Tool-call resolution still reads `context.tools`, so a call to a declared but inactive tool gets the existing `Tool <name> not found` result.

### Why

Shrinking the active tool set rewrote the provider `tools` list and dropped the whole cached prefix on OpenAI GPT-5.6+.

### Why an extension could not handle it

The provider context is assembled inside the agent loop from its context snapshot; no hook runs between the snapshot and the stream call.

### Expected merge conflict zones

- LOW: `buildProviderContext` in `agent-loop.ts` plus one import; `createMutableAgentState`, `buildProviderContext` and `createContextSnapshot` in `agent.ts`; `AgentState` / `AgentContext` in `types.ts`.

## 2026-09-23 - A resolved tool-call name is invisible outside the model's view (senpi#2064)

### What changed

- `packages/agent/src/tool-name-alias.ts`: owns `resolveCallTool` (exact name, then the host `resolveUnknownToolCall`, then the alias rule) and `withToolNameCorrection`, moved out of `agent-loop.ts`. The `[auto-corrected]` notice is now a model-only text part (`audience: "model"`, senpi#2041): the model still receives the exact text, renderers omit it.
- `packages/agent/src/agent-loop.ts`: the sequential and parallel executors resolve the tool before emitting `tool_execution_start`, so the start event names the tool that runs, matching `tool_execution_end` and the tool result. `prepareToolCall` takes the resolved tool.

### Why

- After senpi#2025 the call ran as the resolved tool, but the user still saw the correction: the start event and the transcript carried the requested `mcp__<id>__Edit` name, and the notice was plain visible text.

### Why an extension could not handle it

- Tool resolution and event emission happen inside the agent loop before any hook runs.

### Expected merge conflict zones

- LOW: the `tool_execution_start` emit sites in `executeToolCallsSequential`/`executeToolCallsParallel` and the head of `prepareToolCall` in `agent-loop.ts`; `tool-name-alias.ts` (fork-only).

## 2026-09-23 - Resolve gateway-namespaced and recased tool-call names (senpi#2025)

### What changed

- `packages/agent/src/tool-name-alias.ts`: new `resolveToolNameAlias(requested, available)`. An exact name wins; otherwise a `mcp__<id>__` gateway namespace is stripped and the remainder is compared with case and `-`/`_` separators folded away. A name resolves only when exactly one available tool owns the folded key, so two candidates are never guessed between. `toolNameCorrectionNotice` renders the `[auto-corrected]` line the result carries.
- `packages/agent/src/agent-loop.ts`: `prepareToolCall` tries the alias against the active tools after the exact lookup and the host's `resolveUnknownToolCall`. When the resolved tool's name differs from the requested one, preparation continues on a copy of the call carrying the canonical name, so `beforeToolCall`, execution, `tool_execution_update`/`tool_execution_end` and the tool result all see the registered name; the result is prefixed with the correction notice. Sequential-mode lookup and immediate outcomes use the resolved call.
- `packages/agent/src/index.ts`: exports `resolveToolNameAlias` so a host with a deferred catalog applies the same rule.

### Why

- On a Claude-Code-compatible gateway path the model sees non-native tools as `mcp__<id>__<PascalName>`. For a deferred tool it learned by its bare name from `tool_search`, a model wrote `mcp__686f__team_create`; the exact lookup answered `Tool mcp__686f__team_create not found` and a full turn was wasted before the model retried the bare name. senpi#1480 already folds the same shapes when repairing replayed history; the inbound call path had no equivalent.
- Hooks must see the canonical name: a permission hook that matches `bash` would otherwise be bypassed by a call named `mcp__x__Bash` that still ran `bash`.

### Why an extension could not handle it

- Tool lookup happens inside the agent loop before any `tool_call` hook fires; an extension cannot rename a call the loop has already rejected as unknown.

### Expected merge conflict zones

- MEDIUM: `prepareToolCall` in `packages/agent/src/agent-loop.ts` (split into `prepareToolCall` + `prepareResolvedToolCall`), the `PreparedToolCall` type, and the tail of `finalizeExecutedToolCall`.
- LOW: `packages/agent/src/tool-name-alias.ts` is new; one export line in `packages/agent/src/index.ts`.

## 2026-09-22 - Tool-argument preparation runs on a detached copy (senpi#1472)

### What changed

- `packages/agent/src/tool-arguments.ts`: new home for `prepareToolArguments` and `prepareAgentToolCallArguments`. The shim now receives `structuredClone(args)`, so what it returns is always a separate object from the one the assistant message holds.
- `packages/agent/src/index.ts`: exports `prepareToolArguments` so a package outside the agent loop reaches the same detach seam instead of calling a tool's shim directly.
- `packages/agent/src/agent-loop.ts`: delegates `prepareAgentToolCallArguments` to that module and re-exports it, so the public surface is unchanged. The old identity guard (`prepared === toolCall.arguments` short-circuits to the original call) is gone: it only ever held for a shim that returned its input, which is exactly the shim that had already rewritten it.
- `packages/senpi-codemode/src/tool/render.ts`: the eval call renderer clamps the summary it displays through `clampEvalSummary`. Before this change the in-place mutation clamped the message itself, so every render surface inherited the limit for free; with preparation detached, the persisted assistant keeps the provider's full summary and a rebuilt transcript would have shown it untruncated. The clamp is idempotent, so a live turn (whose `tool_execution_start` already carries the prepared arguments) renders identically.

### Why

- `prepareArguments` is documented as a normalizer, but several shims normalize by mutating the object they were handed and returning that same reference: `packages/senpi-codemode/src/tool/eval-tool.ts` assigns and deletes `record.summary`, and `packages/agent/src/harness/tools/edit.ts` assigns `args.edits`. That object is the one stored in the assistant message, so preparation silently rewrote the answer the provider had produced.
- On the `claude-sdk-oauth` lane the consequence is expensive rather than cosmetic. `AssistantCommitBoundary` fingerprints the streamed assistant at `message_update` and the committed assistant at `message_end`; a mutated tool argument makes those digests differ, the turn commits as `assistant_rewritten`, the binding is invalidated, and the next turn re-sends the whole conversation. senpi#1472 measured a single such re-send at 1,209,471 bytes with 562,740 cache-write tokens, and one reporting session hit it eleven times.
- The same mutation also breaks restarts: the persisted sidecar stores `assistantContentHash` of the committed assistant, and a later run compares it against the transcript copy that preparation had already edited.
- Fixing it at the caller covers every shim, present and future, instead of the one tool that happened to be reported. `validateToolArguments` (`packages/ai/src/utils/validation.ts`) already clones for the same reason, so the cost profile is established.

### Why an extension could not handle it

- `prepareArguments` is invoked by the agent loop between the provider stream and tool execution. No extension hook sits at that seam, and an extension cannot change how the loop hands arguments to a tool it does not own.

### Expected merge conflict zones

- LOW: the import block of `packages/agent/src/agent-loop.ts` and the single re-export line where `prepareAgentToolCallArguments` used to be defined.
- LOW: `packages/agent/src/tool-arguments.ts` is new; upstream has no file at that path.

## 2026-09-16 - Grammar-backed fold boundaries for structural reads (senpi#1685)

### What changed

- `packages/agent/src/harness/utils/read-folders/tree-sitter/syntax.ts`: a pure fold rule over a parsed syntax tree. It mirrors the compiler oracle's whitelist - block, module, switch, object and array interiors plus non-documentation comments - and protects parameter lists, heritage clauses, decorators, import declarations, binding patterns, computed member names, destructuring assignment targets, type annotations, `as`/`satisfies` operands and every declaration line through the line that opens its body. Any candidate overlapping a protected interval is dropped.
- `packages/agent/src/harness/utils/read-folders/tree-sitter/engine.ts`: loads one grammar per language on first use, parses inside a 250 ms budget, and returns the injected fallback folder's own result when the grammar is absent, the tree has an error or the budget is exhausted.
- `packages/agent/src/harness/utils/read-folders/tree-sitter/grammar-assets.ts`: resolves the vendored grammar and runtime artifacts from the package, the compiled binary's embedded assets, or the pinned measurement dependency, in that order.
- `packages/agent/src/harness/utils/read-folders/compose.ts`: the hierarchy and scan-to-result composition both engines share, lifted out of `packages/agent/src/harness/utils/read-folders/index.ts`.
- `packages/agent/src/harness/utils/read-folders/prepare.ts`: resolves the folder a default read must use for a path; only a language the frozen selection binds to `wasm` loads a grammar.
- `packages/agent/src/harness/utils/read-folders/index.ts`: the frozen selection now names `wasm` for `.js` with the measured raw reasons for TypeScript and TSX, and `isReadSummaryPath` accepts a `wasm` selection.
- `packages/agent/src/harness/tools/read.ts`: awaits the prepared folder before composing the default summary.
- `packages/agent/src/index.ts` and `packages/agent/src/runtime-assets.d.ts`: export the prepare seam and declare the packaged WebAssembly asset imports.

### Why

- After #1644 the dependency-free scan qualified only for JSON; TypeScript and JavaScript were frozen raw pending the owner's WASM decision. #1685 answered it, and the re-run bake-off measures both engines per language under the same oracle, threshold rule and frozen-selection mechanism: JavaScript reaches a 41.93% median token saving against its 35.54% bar (heuristic: 0%), while TypeScript and TSX stay raw because the minimum oracle skeleton of most of their files exceeds the view's 100 visible-line budget.

### Why an extension could not handle it

- The read tool's default output and its frozen per-language selection are decided inside the agent package before any extension hook observes the read; an extension cannot change which folder the tool composes, nor bind an engine to the measurement receipt.

### Expected merge conflict zones

- LOW: the `READ_FOLDER_SELECTION` literal and the `fold` switch in `packages/agent/src/harness/utils/read-folders/index.ts`, which the fork already owns.
- LOW: the summary call site in `packages/agent/src/harness/tools/read.ts`, now preceded by an awaited folder resolution.

## 2026-09-16 - Fork-local rate guard withdrawn; the loop bounds silence only (senpi#1759)

### What changed

- `packages/agent/src/agent-loop.ts`: the assistant event reader no longer measures how fast a live stream delivers, and no longer aborts the request controller on a rate verdict. It is back to the two silence bounds - the stream-start bound until the first event, and the inter-event idle bound.
- `packages/agent/src/types.ts`: the loop-config option that carried the rate thresholds is removed.
- `packages/agent/src/agent.ts`: the matching runtime option, its public field and its forwarding into every loop config are removed.
- `packages/agent/src/index.ts`: the exports that published that module's surface are removed, and the module itself is deleted.

### Why

- The guard failed healthy turns: a normal stream measured just under the shipped floor had its request aborted mid tool call, and thinking-heavy models and gateways that batch several tokens into one delta routinely stay under it. Aborting the controller also discarded the partial answer instead of delivering it slowly. It is withdrawn rather than retuned, so these files match their pre-guard shape again.

### Why an extension could not handle it

- The bound lived inside the agent loop's stream reader, which no extension can observe or replace; removing it likewise has to happen here.

### Expected merge conflict zones

- LOW: `createAssistantEventReader` / `readNextAssistantEvent` in `packages/agent/src/agent-loop.ts` are back to the upstream shape, so an upstream edit to the start or idle bounds now applies cleanly.

## 2026-09-16 - Forward thinking live in the empty-assistant recovery wrapper (#1733)

### What changed

- `packages/agent/src/empty-assistant-recovery.ts` commits an attempt (starts forwarding) on the first meaningful content event: non-blank `thinking_delta`, visible `text_delta`, `toolcall_start`, or a `text_end`/`thinking_end` carrying content. Previously only `toolcall_start` and visible `text_delta` committed, so a reasoning model's whole thinking phase was buffered.
- `CommitPolicy.thinkingCommits` is false for the Kimi XTML lane (`hasKimiTextToolCallRecovery`): that thinking channel is the documented misrouting vector for text tool calls, and `wrapStreamWithKimiThinkingRecovery` forwards deltas untouched and only rewrites the finished message, so streaming it live would expose protocol fragments the recovery later removes (the #759 production incident). Kimi keeps the buffered contract until the thinking recovery sanitizes deltas and partials as they stream.
- A committed attempt that ends as an empty stop or a `tool_use` stop without a tool call is not retried inside the wrapper. It ends as a `stopReason: "error"` message with `FORWARDED_EMPTY_RESPONSE_ERROR` / `FORWARDED_EMPTY_TOOL_USE_ERROR` (defined in pi-ai `utils/empty-response-errors.ts`), the streamed content preserved, and a `{ retries: 0, forwarded: true }` recovery diagnostic. pi-ai's retry classifier treats those two texts as retryable, so `AgentSession` drops the message from agent state and re-requests.
- Uncommitted attempts keep the one silent retry and the terminal "twice" errors unchanged.

### Why

- Session data over seven days showed 79-83% of Claude and Kimi turns with thinking were held invisible for a median of 15-28 s (p90 31-52 s) until the first text delta, while the wrapper's silent retry fired 12 times in 58,801 assistant messages. oh-my-pi's `withReplaySafeStreamRetry` commits on `thinking_delta` and leaves post-commit empty stops to its session-level turn recovery; this mirrors that split with senpi's existing turn retry.

### Why an extension could not handle it

- The hold happens inside the agent loop's stream function wrapper, below `before_provider_request` and above every subscriber; no extension hook observes events before they are forwarded.

### Rejected alternative

- Replaying a retry after forwarding and splicing its events onto the first attempt's partial. A second `start` duplicates the partial message in the loop, and a message mixing attempt-one thinking with attempt-two content cannot be replayed to Anthropic, whose signed thinking blocks must be returned unmodified with the response that produced them.

### Expected merge conflict zones

- MEDIUM: `packages/agent/src/empty-assistant-recovery.ts` forwarding gate and terminal handling; `packages/ai/src/utils/retry.ts` RETRYABLE pattern list. Preserve the split: uncommitted -> in-stream retry, committed -> retryable error.

## 2026-09-15 - Do not fold fields-only class bodies (#1639)

### What changed

- `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` no longer marks a class-body `{` foldable after `HeaderProtection.open` consumes the class header. Initializer objects, static-block bodies and method bodies inside the class remain eligible.
- `packages/agent/src/harness/utils/read-folders/header-protection.ts` returns whether `open` closed a class header, and clears the sticky assignment-target marker on the next word token so ASI-style value objects are not over-protected.
- The adversarial grammar adds class-field, static-block, accessor, computed getter/setter and async-generator computed-method contexts. Enumeration pins 1440 programs / 244 emitted ranges / 0 counterexamples.
- `packages/agent/src/harness/utils/read-folders/index.ts` re-freezes the measured selection receipt hash and its measurement commit after the requalified bake-off.

### Why

- A class whose members are only fields or `static` blocks has no method-header intervals, so a wholesale class-body fold hid every member declaration and emitted a range the independent oracle rejects.

### Why an extension could not handle it

- The public folder returns these ranges below either reader's extension surface; member declarations must remain visible before rendering or qualification.

### Expected merge conflict zones

- MEDIUM: `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` class-body foldability and `header-protection.ts` `open` return. Preserve the class-body exclusion; do not whitelist `ClassBody` in the oracle.

## 2026-09-14 - Computed members and assignment-pattern retention (#1639)

### What changed

- `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` protects computed names in object literals as well as class bodies, and marks every value-position array/object so a later `=` can reclassify it.
- `packages/agent/src/harness/utils/read-folders/header-protection.ts` gives every protected member context an interval for the overlap filter, and retrospectively protects expression-shaped assignment targets at `=`.
- `packages/agent/src/harness/utils/read-folders/lexical-context.ts` replaces the class-only computed-name marker with that value-position marker; the brace parent now supplies member context.
- `packages/agent/src/harness/utils/read-folders/index.ts` re-freezes the measured selection receipt hash and its measurement commit after the requalified bake-off.
- The independent AST oracle excludes complete assignment target subtrees, and the production bake-off requires the fixed adversarial grammar to pass before freezing a receipt.

### Why

- Computed member names and destructuring-assignment defaults can contain executable object literals without becoming implementation bodies. Both interior and enclosing folds must retain them.

### Why an extension could not handle it

- The public folder returns these ranges below either reader's extension surface; safety must be proved before rendering or qualification.

### Expected merge conflict zones

- MEDIUM: `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` and `packages/agent/src/harness/utils/read-folders/header-protection.ts` delimiter state. Preserve retrospective target protection and rejection of every overlapping fold.

## 2026-09-14 - Declaration-safe read qualification (#1639)

### What changed

- `packages/agent/src/harness/utils/read-folders/header-protection.ts` tracks class/function headers and protected parameter, binding and nested declaration intervals until a proven implementation body.
- `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` rejects every candidate range that overlaps those intervals and fails raw when a type/operator boundary cannot be proved.
- `packages/agent/src/harness/utils/read-folders/{index,lexical-context,lexical-spans}.ts` freeze the requalified JSON-only default while retaining safe JS/TS candidates for measurement.

### Why

- Declaration text inside class heritage, return types or nested headers must remain visible even when a numerically valid outer body range would contain it. The conservative candidate no longer meets the JavaScript quality threshold, so JavaScript must ship raw.

### Why an extension could not handle it

- The shared folder and default-language registry run below extensions in both read implementations; only this layer can prevent unsafe ranges from reaching the renderer.

### Expected merge conflict zones

- MEDIUM: `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` lexical state and `index.ts` frozen selection. Preserve overlap rejection and JSON-only enablement during upstream integration.

## 2026-09-13 - Corrective production read selection (#1639)

### What changed

- `packages/agent/src/harness/tools/read.ts` reuses `FileError("aborted")` after fresh bytes and before folding.
- `packages/agent/src/harness/utils/read-folders/index.ts` originally bound JS/JSON defaults; the 2026-09-14 requalification above supersedes that selection and keeps JS/TS raw.
- `packages/agent/src/harness/utils/read-folders/brace-scanner.ts` protects arrow-return signatures and classifies definite call arguments, balanced brace-free type arguments and comparison scopes without dropping ambiguity guards.
- `packages/agent/src/harness/utils/segmented-read-view.ts` proves renderer exhaustiveness while preserving runtime invalid-segment errors.

### Why

- `packages/agent/src/harness/tools/read.ts` must preserve the environment's structured cancellation code rather than throwing an untyped cancellation error.

### Why an extension could not handle it

- `packages/agent/src/harness/tools/read.ts` is the injectable lower-level filesystem reader below extension execution.

### Expected merge conflict zones

- `packages/agent/src/harness/tools/read.ts`: error imports and the post-read cancellation check; both truncators remain unchanged.

## 2026-09-13 - Structural default reads with exact range fallback

### What changed

- `packages/agent/src/harness/tools/read.ts`: default construction injects the frozen folder and composes the shared view only after the existing truncator accepts the input. Explicit ranges and optional-folder absence preserve verbatim reads; cancellation is checked before folding.
- `packages/agent/src/harness/utils/segmented-read-view.ts`: adds the shared default-read eligibility adapter without duplicating rendering or footer policy.
- `packages/agent/src/harness/utils/read-folders/index.ts`: exposes eligibility from the frozen language selection so custom folders cannot bypass prose/unsupported exemptions.

### Why

- `packages/agent/src/harness/tools/read.ts` must match the coding-agent reader's default summary and exact offset/limit rereads without altering existing truncation inclusivity or edit anchors.

### Why an extension could not handle it

- `packages/agent/src/harness/tools/read.ts` is the lower-level injectable tool used without the coding-agent extension runtime; both readers must call the same pure implementation.

### Expected merge conflict zones

- LOW: imports, default options and the text-output branch in `packages/agent/src/harness/tools/read.ts`. Preserve the raw/truncation branches and both truncate modules unchanged.

## 2026-09-13 - Measured folders and shared segmented read views

### What changed

- `packages/agent/src/index.ts`: exports the selected folder, immutable D4 policy and pure segmented-view contract.
- `packages/agent/src/harness/tools/read.ts`: adds the optional `ReadToolOptions.folder` type seam only; execution is unchanged pending read integration.
- `packages/agent/src/harness/utils/segmented-read-view.ts`: owns segment validation, FIFO breadth-first refinement, exact source rendering and offset/limit footer metadata.
- `packages/agent/src/harness/utils/read-folders/{index,types,brace-scanner,lexical-spans}.ts`: productionizes the row-17 TS/JS/JSON scanner and frozen selection without grammar dependencies; unsupported languages and prose remain explicit fallbacks.

### Why

- `packages/agent/src/index.ts` exposes a single reusable contract so both read surfaces can consume identical validated views without an agent-to-coding-agent dependency.
- `packages/agent/src/harness/tools/read.ts` reserves the folder injection seam without changing today's raw reader before parity integration is verified.

### Why an extension could not handle it

- `packages/agent/src/index.ts` and `packages/agent/src/harness/tools/read.ts` own the public library exports and reader options used below the coding-agent extension layer.

### Expected merge conflict zones

- LOW: `packages/agent/src/index.ts` utility re-exports and `packages/agent/src/harness/tools/read.ts` imports/options; no execute or truncation changes.

## 2026-09-13 - Keep the harness/session entry graph off the AI barrel

### What changed

- `packages/agent/src/harness/messages.ts`: `dropFailedAssistantTurns` is imported from `@earendil-works/pi-ai/utils/drop-failed-assistant-turns` and AI message types stay `import type` from the barrel. `convertToLlm` behavior is unchanged.

### Why

- `./harness/session` value-imports `jsonl/legacy-v3.ts` through storage/repo, and that file value-imports the two summary factories from `messages.ts`. The mixed barrel import of `dropFailedAssistantTurns` (ab68b5eb0) turned that type-only edge into a runtime walk of `packages/ai/src/index.ts` (132 files vs budget 25). The helper is a leaf already exported on `./utils/*`.

### Why an extension could not handle it

- Entry-graph budgets are a compile-time import contract. Extensions cannot change which module `messages.ts` evaluates.

### Expected merge conflict zones

- LOW: the import lines at the top of `packages/agent/src/harness/messages.ts`.

## 2026-09-10 - Honor an inline isError on returned tool results

### What changed

- packages/agent/src/types.ts: `AgentToolResult` declares `isError?: boolean` so a tool can report a failure without throwing while keeping `content` and `details` intact.
- packages/agent/src/agent-loop.ts: `executePreparedToolCall` carries `settled.isError === true` into the executed outcome instead of hardcoding `isError: false`, so `tool_execution_end` and the `toolResult` message flag the failure.

### Why

- Structured-failure tools (omo's team and memory tools, the terminal tool) return `isError: true` with typed `details` for the model to branch on. The loop dropped that flag, so the TUI painted the row as success, the RPC `tool_execution_end.isError` the desktop GUI maps to "failed" stayed false, and `tool_result` hooks saw a success.

### Why this lives in the fork

- The error flag is decided inside the loop's execution outcome before any hook runs; extensions can only rewrite it per tool through `tool_result`, not restore the contract for every tool.
- This deliberately diverges from upstream pi-mono, which documents "returning a value never sets the error flag"; `packages/coding-agent/docs/extensions.md` now documents both signaling paths.

### Expected merge conflict zones

- `executePreparedToolCall` return in packages/agent/src/agent-loop.ts and the `AgentToolResult` interface in packages/agent/src/types.ts.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/agent/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/agent/package.json.
## 2026-09-05 - Preserve Astra reasoning effort across session changes

### What changed

- packages/agent/src/agent.ts: preserve the branch reasoning baseline for GPT-6 Astra requests.
- packages/agent/src/harness/agent-harness.ts: persist trusted configuration-update entries.
- packages/agent/src/harness/compaction/branch-summarization.ts: preserve configuration-update entries through branch summaries.
- packages/agent/src/harness/compaction/compaction.ts: keep configuration-update entries at compaction boundaries.
- packages/agent/src/harness/reducer.ts: restore effective configuration-update state.
- packages/agent/src/harness/session/context.ts: replay the latest configuration update.
- packages/agent/src/harness/session/jsonl/codec.ts: decode configuration-update entries.
- packages/agent/src/harness/session/types.ts: define the durable configuration-update entry.
- packages/agent/src/types.ts: carry the configuration-update message role.

### Why

- GPT-6 Astra changes reasoning through a positional configuration-update item so request-level effort remains stable for prompt caching.

### Why this lives in the fork

- The agent loop and durable session contracts own baseline and replay state before provider adapters run.

### Expected merge conflict zones

- Agent loop configuration and session entry unions.

## 2026-09-05 - Preserve Astra reasoning effort across session changes

### What changed

- `packages/agent/src/agent.ts`, `packages/agent/src/agent-loop.ts`, `packages/agent/src/types.ts`, and `packages/agent/src/harness/**` preserve the branch reasoning baseline and durable configuration-update state while keeping non-Astra thinking changes unchanged.

### Why

- GPT-6 Astra changes reasoning through a positional configuration-update item so request-level effort remains stable for prompt caching.

### Why this lives in the fork

- The agent loop and durable session contracts own baseline and replay state before provider adapters run.

### Expected merge conflict zones

- Agent loop configuration and session entry unions.

# Changes

## 2026-09-08 - Recover empty native tool-use responses

### What changed

- `packages/agent/src/empty-assistant-recovery.ts`: retry terminal native `toolUse` responses with no tool-call blocks once, then surface an error and telemetry diagnostic; preserve existing empty-stop gating.
- `packages/agent/src/assistant-terminal-state.ts`: demote contradictory tool-use terminal messages without tool calls, stamping an `empty_tool_use_terminal_state` diagnostic so the demotion stays identifiable after the stop reason is rewritten.
- `packages/agent/src/agent-loop.ts`: compose terminal normalization with pending-tool promotion.
- `packages/agent/src/index.ts`: export `EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC` so the goal builtin can recognize a demoted malformed turn.

### Why

- Providers can lose a streamed tool call while retaining the `toolUse` stop reason, which otherwise silently ends the user's session.

### Why an extension could not handle it

- Provider stream buffering and terminal-state normalization occur inside the core agent loop before extension callbacks observe the message.

### Expected merge conflict zones

- MEDIUM: `empty-assistant-recovery.ts` stream terminal handling and `agent-loop.ts` terminal message normalization.
- LOW: the `assistant-terminal-state.ts` re-export line in `index.ts`.


## 2026-09-04 - Drop the byte count from write-tool results

### What changed

- `packages/agent/src/harness/tools/write.ts`: the write tool's success text reports `Successfully wrote to <path>` without the byte count, adopting upstream e583b290a; the fork's tool tests were aligned to the wording in 9e64e52d1.

### Why

- The count reported UTF-16 code units as bytes, which is wrong for any non-ASCII payload; upstream removed the count instead of rescanning the content.

### Why an extension could not handle it

- The result text is produced inside the built-in write tool before any extension hook can rewrite it.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/tools/write.ts` success-note wording during upstream syncs.

## 2026-09-04 - Harden the proxy stream boundary and pass through provider thinking levels

### What changed

- `packages/agent/src/proxy.ts`: `streamProxy` flushes the decoder and processes a final SSE line that is not newline-terminated, and a clean EOF that never produced a done or error event pushes a synthesized error (`Connection closed by proxy server before the response completed`) instead of ending the stream with no result (upstream ebc374490, #8997).
- `packages/agent/src/proxy.ts`: terminal done and error proxy events carry an optional `providerThinkingLevel` that is copied onto the partial assistant message, part of the sync's per-turn thinking-effort preservation (upstream 4e69b0c28).

### Why

- A proxy that dropped the connection mid-response left `EventStream.result()` pending forever because no terminal event ever arrived; consumers awaiting the result hung indefinitely. Surfacing the provider's actual thinking level lets the session observe what the provider admitted for the turn instead of inferring it from the request.

### Why an extension could not handle it

- The proxy SSE transport is the runtime streaming boundary beneath every extension hook; extensions cannot synthesize terminal events or repair a dropped stream.

### Expected merge conflict zones

- MEDIUM: `packages/agent/src/proxy.ts` read loop, residual-buffer flush, and terminal-event synthesis.

## 2026-09-04 - Run next-turn preparation after every completed turn

### What changed

- Invoke `prepareNextTurn` after every completed assistant turn that can reach the preparation boundary, including a normal stop response with no tool calls, while preserving the terminating queue boundary and ownership refresh before a continuation provider request.

### Why

- The upstream loop only prepared at the top of a re-entered inner loop, so a completed no-tool turn could emit `agent_end` without running the session's next-turn admission hook.

### Why an extension could not handle it

- Turn completion, queue draining, and provider admission ordering are owned by the core agent loop before extension callbacks can observe or alter them.

### Expected merge conflict zones

- MEDIUM: `agent-loop.ts` completed-turn preparation and terminating queue boundary; `types.ts` preparation callback contract.

## 2026-09-04 - Honor queue clears on terminating continuations

### What changed

- Emit the terminating continuation boundary before refreshing drained queue messages, so a queue clear or replacement at `turn_start` wins before pending input is injected.

### Why

- A terminating tool previously moved queued input into loop-local state before the continuation boundary, allowing cleared steering or follow-up messages to reach the provider.

### Why an extension could not handle it

- Terminating queue ownership and continuation-boundary ordering are enforced inside the core agent loop before extension hooks can change the provider request.

### Expected merge conflict zones

- MEDIUM: `agent-loop.ts` terminating queue refresh and continuation turn admission; `types.ts` loop configuration contract.

## 2026-09-03 - Restore queue ownership and preflight abort barriers

### What changed

- Restored classifier refusals as terminal assistant turns, preserved terminating queue re-poll/restore ownership across next-turn preparation, and completed all parallel tool preflight checks before releasing execution.

### Why

- The upstream loop merge allowed refused calls, cleared queue snapshots, and already-prepared tools to cross the next provider/execution boundary.

### Why an extension could not handle it

- Queue drain ownership and tool execution scheduling are core agent-loop responsibilities before extension hooks can observe or veto execution.

### Expected merge conflict zones

- MEDIUM: `agent-loop.ts` turn admission, queue restoration, and parallel tool scheduling.

## 2026-09-04 - Failed provider turns leave the LLM context on every lane

### What changed

- `packages/agent/src/harness/messages.ts`: the harness `convertToLlm` runs the shared `dropFailedAssistantTurns` from `@earendil-works/pi-ai` as its final step, removing assistant turns with `stopReason` `error`/`aborted` and the tool results orphaned by that drop from the returned `Message[]`; an id re-declared by a kept assistant keeps its result, and `stop`/`length`/`toolUse` turns pass through untouched.
- `packages/agent/src/harness/compaction/compaction.ts`: `estimateContextTokens` applies the same `dropFailedAssistantTurns` before anchoring on usage and summing trailing tokens, so the estimate counts exactly the set the next request carries; failed turns and their orphaned results no longer inflate the compaction trigger.
- `packages/agent/test/harness/convert-to-llm.test.ts` (new) and `packages/agent/test/harness/compaction.test.ts`: pin the harness `convertToLlm` drop (error, aborted, re-declared-id keep) and the estimator exclusion for both failure kinds.

### Why

- Compaction, branch summarization, and any consumer building an LLM request from the converted list had no `stopReason` filter, so after a provider error or abort every subsequent request replayed the failed turn's partial text and unexecuted tool calls; the provider transform layer dropped them for pi-ai API requests only.

### Why an extension could not handle it

- The drop must happen inside `convertToLlm`, which consumers call before any extension seam runs; extensions observe the already-built context and cannot remove a failed assistant turn from every downstream request shape deterministically.

### Expected merge conflict zones

- LOW: the tail of `convertToLlm` in `packages/agent/src/harness/messages.ts` (the new `dropFailedAssistantTurns` return).
- LOW: the head of `estimateContextTokens` and the `counted` parameter of `getLastAssistantUsageInfo` in `packages/agent/src/harness/compaction/compaction.ts`.

## 2026-09-02 - Name the stream-start timeout setting

### What changed

- `StreamStartTimeoutError` now names `retry.provider.streamStartTimeoutMs` and explains that `0` disables the guard.

### Why

- A provider stream-start timeout must tell users which setting to raise when the configured bound is too aggressive.

### Why an extension could not handle it

- The error is constructed inside the core provider stream loop before extension code can alter its user-visible message.

### Expected merge conflict zones

- LOW: `agent-loop.ts` stream-start timeout error wording.

## 2026-08-29 - Propagate asynchronous shell capture callbacks

### What changed

- `packages/agent/src/harness/types.ts`, `packages/agent/src/harness/env/nodejs.ts`, and `packages/agent/src/harness/utils/shell-output.ts` now observe asynchronous stdout, stderr, and capture callbacks, terminate execution on rejection, and preserve the original rejection as the execution error cause.

### Why

- Exported shell capture callbacks could reject while large-output commands still resolved successfully, leaving spill files and an unhandled rejection.

### Why an extension could not handle it

- Stream callback dispatch and process cleanup occur inside the harness execution environment before tool or agent extension hooks run.

### Expected merge conflict zones

- LOW: shell stream callback types and dispatch in the Node execution environment and shell capture adapter.

## 2026-08-27 - Optional postMutate seam inside the file mutation queue

### What changed

- `packages/agent/src/harness/tools/tool-context.ts` adds an optional `postMutate` hook to
  `ExecutionToolContext` plus the `PostMutateContext`, `PostMutateResult`, and `PostMutateHook`
  contracts describing it.
- `packages/agent/src/harness/tools/post-mutate.ts` (fork-only) runs the hook and degrades a
  rejecting hook into an appended warning note, so a landed write is never discarded.
- `packages/agent/src/harness/tools/write.ts` invokes the hook inside the `withFileMutationQueue`
  callback right after `env.writeFile` succeeds and appends the returned note to the success text.
- `packages/agent/src/harness/tools/edit.ts` invokes the hook in the same position and re-reads the
  file whenever the hook may have touched it (`changed: true`, or the hook rejected after a partial
  rewrite) so the returned diff, unified patch, and first-changed-line describe the bytes actually
  on disk. A hook that leaves the file unreadable is reported as a note on the successful edit
  rather than as an edit failure, because the edit itself already landed.
- `packages/agent/src/harness/tools/index.ts` exports the new post-mutate types.

### Why

Fork tooling (formatters, codegen, normalizers) must observe and adjust a file as an atomic part of
the mutation that produced it. A `tool_result` extension hook runs outside the mutation queue, so a
concurrent same-path mutation can interleave and the edit tool's diff metadata can describe bytes
that are no longer on disk. Placing the seam inside the queue slot makes the post-write step
unobservable to other mutations and lets edit report the committed content.

### Why an extension could not handle it

`withFileMutationQueue` is internal to the harness tool implementations; no extension hook executes
inside a queue slot, and the edit tool computes its diff metadata before any extension sees the
result.

### Expected merge conflict zones

- LOW: the `execute` bodies of `write.ts` and `edit.ts` (post-`writeFile` lines), the
  `ExecutionToolContext` declaration in `tool-context.ts`, and the `tool-context.ts` export block in
  `index.ts`.

## Agent loop config surface re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/agent/src/agent.ts` keeps the fork run-loop surface on top of upstream: the
  `buildProviderContext` re-export from `agent-loop.ts`, and the config passthroughs `timeoutMs`,
  `streamStartTimeoutMs`, `removedToolHints`, `resolveUnknownToolCall`, `abortServerSideFallback`,
  and `cursorExecHandlers`.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The `AgentConfig`/loop-config type blocks and the `agent-loop.ts` import list in
  `packages/agent/src/agent.ts`.

## 2026-08-25 - Preserve provider retry watchdog abort provenance

### What changed

- `packages/agent/src/agent.ts` accepts an abort reason and emits a provider-owned assistant abort for retry-watchdog cancellation.
- `packages/agent/src/agent-loop.ts` preserves an explicit abort Error instead of replacing it with generic `Request was aborted` text.
- `packages/agent/src/assistant-terminal-state.ts` stamps provider provenance where terminal stream failures are constructed.
- `packages/agent/src/index.ts` exports the typed watchdog abort reason for session hosts.

### Why

- The session watchdog must carry the real provider stall cause through low-level Agent cancellation so retry classification and terminal reporting do not lose the provider failure.

### Why an extension could not handle it

- Abort reason propagation and assistant failure-message construction occur inside the browser-safe agent lifecycle.

### Expected merge conflict zones

- LOW: `agent.ts` abort API and `agent-loop.ts` event-reader cancellation path.

## 2026-08-20 - End the turn when idle after completed Cursor tools

### What changed

- `packages/agent/src/agent-loop.ts`: `streamAssistantResponse` catch now treats `StreamIdleTimeoutError` after Cursor-resolved tools or buffered exec results as a finished turn (`stopReason: "stop"`) instead of a terminal error.
- `packages/agent/src/assistant-terminal-state.ts`: `isStreamIdleTimeoutError` and `shouldFinalizeIdleAsStop` decide when that idle is a completed turn versus a real hang.

### Why

- After Cursor-resolved tools (or buffered exec results) the parent stream can sit silent until the 300s idle timeout and die as `StreamIdleTimeoutError` even though the child work already finished (issue #997).

### Why an extension could not handle it

- The idle reader and `streamAssistantResponse` catch live inside the agent loop; no extension hook sits between the idle timeout and the terminal assistant message it currently emits.

### Expected merge conflict zones

- `packages/agent/src/agent-loop.ts` `streamAssistantResponse` catch
- `packages/agent/src/assistant-terminal-state.ts` idle helpers appended after `shouldTerminateAssistantTurn`

## 2026-08-20 - Continue when stop still has pending toolCalls

### What changed

- `packages/agent/src/assistant-terminal-state.ts`: `promoteStopWithPendingToolCalls` rewrites assistant `stopReason` from `stop` to `toolUse` when the message still contains `toolCall` blocks; text-only stop stays terminal.
- `packages/agent/src/agent-loop.ts`: apply that promotion after streaming so pending (non-exec-channel) tool calls execute in the same turn and their results go back to the model. Cursor exec-resolved blocks stay filtered out of the local batch and do not re-enter the loop.

### Why

- Cursor often ends a turn as `stop` while toolCall blocks are still present. The loop treated that as a finished turn and dropped the pending tools (issue #1010).

### Why an extension could not handle it

- Stop-reason classification lives inside the agent loop after the stream returns; no extension hook sits between stream completion and tool-batch execution.

### Expected merge conflict zones

- `packages/agent/src/assistant-terminal-state.ts` promotion helper
- `packages/agent/src/agent-loop.ts` success path after `streamAssistantResponse`

## 2026-08-20 - Cursor exec handlers bind to the owning run signal

### What changed

- `packages/agent/src/agent-loop.ts`: when `config.cursorExecHandlers` is a factory, the loop now
  resolves it with the outer owning-run signal (`signal ?? requestAbortController.signal`) instead of
  the per-request idle-timeout controller, and normal request completion aborts the request-scoped
  fallback so signal-less direct loop callers cannot leave stale handlers live.

### Why

- The bridge session (`cursor-exec-bridge-session.ts`) verifies ownership by identity against the
  agent's live run signal. The per-request controller is a different object by construction, so every
  native Cursor exec frame failed the check and returned `Tool execution has no active run`
  (issues #979/#1000/#1003, regression from 31a71f0c5).

### Why an extension could not handle it

- The factory resolution happens inside the loop's provider-request assembly; no extension hook sits
  between `streamAssistantResponse` and the provider options it constructs.

### Expected merge conflict zones

- `agent-loop.ts` provider-request assembly and the request `finally` teardown (fork-only Cursor exec
  channel; upstream has no cursor provider).

## Finalize idle-after-completed-tools as stop (2026-08-19)

If the provider stream goes idle after Cursor-resolved tool calls (or buffered exec results) and there is no pending local work, the turn ends as `stop` instead of `StreamIdleTimeoutError`. A hang with no tools is still an idle error.

Conflict zone: `agent-loop.ts` `streamAssistantResponse` catch.

## Loop and agent divergence re-established against upstream 59a71b23 (2026-08-19)

### What changed

- `packages/agent/src/agent-loop.ts` stays divergent from the new pin on the fork's own turn machinery:
  per-request stream bounds (`StreamStartTimeoutError` / `StreamIdleTimeoutError`, the
  `initialRequestTimeoutMs` / `initialRequestStreamStartTimeoutMs` overrides that apply to the first
  provider request only, after which the configured idle timeout resumes so a healthy reasoning gap is
  not bound by the short liveness probe);
  queued-input recovery (`drainedTerminatingQueue` plus `refreshTerminatingQueueDrain`, which hands
  steering/follow-up messages back to `config.restorePendingMessages` on every terminating path instead
  of dropping them); `streamKind: "main"` stamped on the loop's own provider request so auxiliary calls
  stay distinguishable downstream; thinking-block `startedAt` / `endedAt` stamping from the
  `thinkingTiming` map at stream-event receipt; the Cursor exec-channel bridge (handler factory resolved
  with the outer owning-run signal rather than the provider request's idle-timeout signal, mid-stream
  tool results buffered and appended, `kCursorExecResolved`
  blocks excluded from the executable tool batch); `withEmptyAssistantRecovery` around the stream fn; and
  the `prepareNextTurn` merge of `thinkingSelection` and `abortServerSideFallback`.
- `packages/agent/src/agent.ts` stays divergent on the run-ownership surface those loop features require:
  `AgentContinuationOptions` (`deferQueuedMessages`, `timeoutMs`, `streamStartTimeoutMs`),
  `continueWithQueuedMessages()` — queue-first continuation that re-delivers drained steering input when a
  compaction leaves custom context at the tail — the `clearGeneration` counter and `prepend()` on the
  message queue, `suppressQueuedMessageDrain()` for one active run, the `restorePendingMessages` wiring
  back into the queues, and the runtime options carried onto the loop config (`timeoutMs`,
  `streamStartTimeoutMs`, `removedToolHints`, `resolveUnknownToolCall`, `abortServerSideFallback`,
  `cursorExecHandlers`).

### Why

- Upstream `59a71b235d` has no per-request stream bounds, no queued-input ownership contract, and no
  provider-executed-tool channel, so every one of these behaviors re-diverges on merge rather than being
  reconciled away. The behavioral rationale for each lives in the dated entries below (stream-start and
  continuation-scoped timeouts 2026-07-29, empty-assistant recovery 2026-07-30, Cursor exec-channel
  contract 2026-08-16 and 2026-08-18, thinking-selection provenance 2026-08-18); this entry records that
  the sync to the new pin leaves both files divergent for exactly those reasons.

### Why an extension could not handle it

- Stream-request construction, abort-signal ownership, the pending-message queues, and the tool-batch
  filter are the loop's own control flow. An extension observes turn events after the fact and cannot
  bound a stream that never emits, re-park input the loop already drained, or exclude a block from the
  batch the loop is about to execute.

### Expected merge conflict zones

- HIGH: `agent-loop.ts` `streamAssistantResponse` request construction and the timeout/idle wrappers;
  the tool-call collection and execution block; the `prepareNextTurn` config merge.
- MEDIUM: `agent.ts` `runPromptMessages` / `continue` entry points and the loop-config assembly that
  forwards the fork's runtime options.

## Cursor exec handlers bind to their owning run (2026-08-18)

### What changed

- `packages/agent/src/types.ts`: `AgentLoopConfig.cursorExecHandlers` also
  accepts a `(runSignal: AbortSignal) => CursorExecHandlers` factory.
- `packages/agent/src/agent-loop.ts`: when a factory is supplied, the loop
  resolves it with the outer owning-run signal. Direct loop callers without an
  outer signal retain the request controller as a scoped fallback, and normal
  request completion aborts that fallback so stale handlers cannot remain live.

### Why

- A host bridge built once per session cannot tell which run an exec frame
  belongs to. Handing it the owning run's signal at stream creation lets the
  host refuse a straggler frame from a stream whose run already ended, instead
  of executing it inside the replacement run.
- The plain-object form is unchanged, so existing hosts keep working.

### Why an extension could not handle it

- Only the loop knows which run owns the stream it is opening. The owning
  signal exists solely inside `streamAssistantResponse` at stream creation, so
  no extension hook can supply it to the host bridge after the fact.

### Expected merge conflict zones

- `agent-loop.ts` `execHandlers` injection block, `types.ts`
  `cursorExecHandlers` declaration.

## 2026-08-18 - Thinking-selection provenance through the agent loop

### What changed

- `packages/agent/src/types.ts`: `AgentState` gains `thinkingSelection`; `AgentLoopTurnUpdate` gains a
  tri-state `thinkingSelection` (undefined leaves unchanged, null clears).
- `packages/agent/src/agent.ts`: `createLoopConfig` forwards the state selection alongside `reasoning`.
- `packages/agent/src/agent-loop.ts`: mid-run `prepareNextTurn` updates re-propagate the selection.
- `packages/agent/src/proxy.ts`: the selection joins the serializable proxy request options.

### Why

- Providers that encode reasoning on the wire (Cursor) must distinguish an explicit user choice from the
  always-materialized effective level, which startup defaults to `medium`.

### Why an extension could not handle it

- Loop config assembly, turn-update merging, and proxy request serialization are core agent-loop seams with
  no extension hook.

### Expected merge conflict zones

- `agent-loop.ts` prepareNextTurn config merge, `proxy.ts` serializable option list, `types.ts` state and
  turn-update interfaces.

## Late Cursor bridge lifecycle events after run teardown (2026-08-18)

### What changed

- `packages/agent/src/agent.ts`: `Agent.emitExternalEvent()` now accepts the
  originating run signal and
  discards bridge-generated lifecycle events when that signal no longer owns
  the active run.

### Why

- Cursor exec handlers can outlive an aborted provider stream. Their final
  `tool_execution_end` event previously reached `processEvents()` after
  `finishRun()` cleared `activeRun`, producing an unhandled
  `Agent listener invoked outside active run` rejection.
- The ownership guard remains specific to externally injected events. Internal
  loop events still require an active run, and listener failures during the
  owning active run still propagate.

### Why the extension system could not handle this

- The race occurs in the engine contract between the provider-owned Cursor exec
  handler and the agent run lifecycle, before an extension can intercept or
  recover the rejected event promise.

### Expected merge conflict zones

- `packages/agent/src/agent.ts`: the external event entry point and active-run
  ownership checks.

> Audit backfill (2026-08-17): the canonical four-section records added today were recorded during
> the repository-wide changes.md audit of divergences from the upstream pin (v0.84.2, `914cf1472e`)
> so every audited production path assigned to this tracker carries a canonical record; they are
> dated by their underlying work. Legacy entries keep their original wording and detail.

## Agent source audit backfill (2026-08-17)

### What changed

- Recorded the fork divergences this tracker owns against the pinned upstream
  (badlogic/pi-mono v0.84.2, `914cf1472e715297caa30db4b9535d534a9eb718`) so the
  repository-wide changes.md audit reports them covered. The pre-backfill audit
  report assigned zero already-covered and thirteen uncovered production paths
  to this tracker; this entry is their canonical four-section record.
- Audited production paths covered by this entry:
  - `packages/agent/src/agent-loop.ts`
  - `packages/agent/src/agent.ts`
  - `packages/agent/src/types.ts`
  - `packages/agent/src/proxy.ts`
  - `packages/agent/src/stream-fn.ts`
  - `packages/agent/src/harness/types.ts`
  - `packages/agent/src/harness/messages.ts`
  - `packages/agent/src/harness/reducer.ts`
  - `packages/agent/src/harness/env/nodejs.ts`
  - `packages/agent/src/harness/session/state.ts`
  - `packages/agent/src/harness/compaction/branch-summarization.ts`
  - `packages/agent/src/harness/compaction/compaction.ts`
  - `packages/agent/src/harness/compaction/utils.ts`
- `packages/agent/src/empty-assistant-recovery.ts` and
  `packages/agent/src/assistant-terminal-state.ts` are fork-only files absent
  from the pin tree, so the audit exempts them; their behavior stays recorded
  in the 2026-08-09 and 2026-07-27 entries.
- Legacy entries predate the canonical four-heading format (their "What changed
  and why" style does not canonicalize), so the per-change detail for the paths
  above remains in those dated entries; the audit-backfill sections added today
  carry the canonical records for the harness reducer, session store,
  compaction, and stream-function surfaces.

### Why

- Root policy requires every fork-specific source change to update the nearest
  `changes.md` in the same verified increment, and `scripts/audit-changes-md.mjs`
  now enforces the canonical-section contract mechanically. Without this record
  the gate reports every agent-core divergence as untracked.

### Why an extension could not handle it

- Tracker hygiene for fork-owned agent-core divergence. The audited surfaces
  themselves (loop scheduling, harness session and compaction internals, proxy
  wire types, stream-function plumbing) execute below the coding-agent
  extension runtime, as the per-change entries already document.

### Expected merge conflict zones

- NONE for this record itself (tracker prose only). The underlying per-file
  zones are unchanged and stay listed in the dated entries: MEDIUM for
  `packages/agent/src/agent-loop.ts` tool-call collection and stream plumbing
  and `packages/agent/src/agent.ts` continuation/lifecycle queues; LOW for the
  harness type, reducer, session-state, Windows kill, proxy wire, and
  compaction content sites.

## 2026-08-16 - Cursor exec-channel contract in the agent loop

### What changed and why

- `agent-loop.ts`: the tool-call collection sites (loop collection and the
  `executeToolCalls` re-filter) skip `toolCall` blocks stamped
  `kCursorExecResolved` — Cursor's server-driven protocol already executed
  those tools mid-stream through the exec bridge, and re-running them would
  duplicate side-effecting bash/write calls.
- `streamAssistantResponse` returns `{ message, providerToolResults }`: when
  `config.cursorExecHandlers` is set, the loop injects `execHandlers` plus a
  buffering `onToolResult` into the stream options; buffered results are
  emitted as ordinary `message_start`/`message_end` events and appended to the
  context right after the assistant message — including on terminal
  error/abort paths, so resolved calls never end up unpaired.
- The idle watchdog (`readNextAssistantEvent`) re-arms instead of failing when
  the provider stream reports pending local work
  (`AssistantMessageEventStream.hasPendingLocalWork`), because a
  server-requested tool run legitimately emits no events while it executes.
- `agent.ts`: `AgentOptions.cursorExecHandlers` flows onto the loop config;
  `emitExternalEvent()` (new) lets the exec bridge inject
  `tool_execution_start`/`tool_execution_end` lifecycle events for tools that
  run inside the provider stream, outside the loop's executor.
- `types.ts`: `AgentLoopConfig.cursorExecHandlers`.

### Why the extension system could not handle this

- Tool-call execution skipping and transcript ordering are loop-core
  decisions made between the provider stream ending and `executeToolCalls`
  starting; no extension hook exists in that window, and a `tool_call` block
  hook can only produce error-shaped results.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-loop.ts` at the tool-call collection block and
  `streamAssistantResponse`'s return shape (upstream returns the bare
  message).
- LOW: `agent.ts` options/config plumbing (additive), `types.ts` additive
  field.

## Durable harness reducer and SessionState projection hardening (2026-08-13)

### What changed

- `packages/agent/src/harness/reducer.ts`: the durable-log projection guards in
  `validateToolStart` and `deriveToolBatch` replaced the negated disjunction
  (`!assistantEntry || assistantEntry.type !== "message" || ...`) with
  optional-chain narrowing (`assistantEntry?.type !== "message" || ...`), so
  tool-start validation and tool-batch derivation keep narrowing the projected
  assistant entry under the repository's warning-as-error type gate.
- `packages/agent/src/harness/session/state.ts`: the fork-target guard applies
  the same optional-chain narrowing (`entry?.type !== "message"`) before
  rejecting a non-message fork target with `invalid_fork_target`.
- `packages/agent/src/harness/types.ts`: `getOrUndefined` is now a generic
  null-to-undefined normalizer — the fork removed the dead Result-unwrapping
  original on 2026-06-10 and the v0.84.x sync reintroduced the name with the
  narrowed semantics — and the harness error classes (`FileError`,
  `ExecutionError`, `CompactionError`) declare a typed `readonly cause`
  assigned after `super()` so `cause` stays typed under ES2021 library
  declarations.
- Consolidates the 2026-08-13 "Upstream harness type cleanup" and 2026-05-11
  "Harness ES2021 diagnostic compatibility" records under the canonical
  four-section format; runtime behavior is unchanged.

### Why

- The merged durable harness code had to pass the fork's stricter diagnostics
  and library level without weakening the durable projection invariants: a tool
  start must reference a projected assistant entry, a fork target must be a
  message entry, and harness errors must carry a typed cause for callers that
  inspect failure chains.

### Why an extension could not handle it

- These guards run inside the durable session reducer and the `SessionState`
  projection, and the error contracts are exported harness primitives consumed
  before any coding-agent extension loads.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/reducer.ts` tool-start validation and
  tool-batch derivation guards; `packages/agent/src/harness/session/state.ts`
  fork-target validation; `packages/agent/src/harness/types.ts`
  `getOrUndefined` and the error-class cause declarations.

## Atomic JSONL publication and session-name clearing on the durable store (2026-08-13)

### What changed

- Adopted, with the upstream v0.84.1/v0.84.2 syncs, the durable session store
  whose JSONL publication is crash-safe:
  `packages/agent/src/harness/session/jsonl/storage.ts` stages a complete
  sibling `.tmp` file and atomically renames it over the destination, so a
  crash while populating a fork or repair leaves the published file untouched
  and at most an ignored temporary behind; a torn tail (an unacknowledged
  partial append after a crash) is repaired by atomically publishing the valid
  prefix.
- Session names became clearable through the same durable mutation log:
  `setName(name: string | undefined)` enqueues a `name` fact mutation and
  passing `undefined` clears the name
  (`packages/agent/src/harness/session/jsonl/storage.ts`,
  `packages/agent/src/harness/session/jsonl/codec.ts`,
  `packages/agent/src/harness/session/memory.ts`,
  `packages/agent/src/harness/session/session.ts`).
- The retired `jsonl-repo`/`memory-repo` layer referenced by the 2026-05-11
  UUID entry is gone; that conflict zone now maps to the store files above
  behind the session facade. The only fork divergence left in this tree is the
  `SessionState` projection guard recorded in the reducer entry.

### Why

- Crash-safe publication and torn-tail repair keep a forked or repaired session
  recoverable instead of half-written, and clearable names let hosts release
  stale labels without deleting durable history. Recording the migration keeps
  the tracker's legacy conflict zones honest after the store refactor.

### Why an extension could not handle it

- JSONL staging, atomic rename, torn-tail truncation, and name-fact mutations
  are storage-layer durability mechanics inside the harness session store,
  below every extension hook.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/session/jsonl/storage.ts` staged publication
  and torn-tail repair; `packages/agent/src/harness/session/state.ts`
  projection guards (fork narrowing only).

## Durable compaction API migration (2026-08-13)

### What changed

- Adopted the promoted durable harness compaction API from the upstream
  v0.84.x syncs: compaction runs against the durable session model with
  Result-typed helpers in `packages/agent/src/harness/types.ts`, compaction
  entries persist as session entries, and the split-turn summary-request
  serialization accepted earlier (2026-07-02 entry) kept its scheduling slot
  through the promotion (`packages/agent/src/harness/compaction/compaction.ts`).
- The fork's surviving compaction-surface divergences on top of the promoted
  API: `CompactionSummaryMessage.details` in
  `packages/agent/src/harness/messages.ts` (provider-native compaction route
  details for TUI rendering and replay, 2026-05-15 entry) and the summary-safe
  request-content wiring plus cut-point retention recorded in the adjacent
  2026-08-13 summary-safe entry.

### Why

- The promotion moved compaction onto the same durability and error contracts
  as the rest of the harness; recording it keeps the tracker's compaction
  history continuous across the API change instead of implying the fork still
  patches the pre-promotion call sites.

### Why an extension could not handle it

- Compaction entry persistence, Result error contracts, and summary-request
  scheduling run inside the harness compaction helpers before coding-agent
  extensions observe a compacted session.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/messages.ts` around
  `CompactionSummaryMessage`; `packages/agent/src/harness/types.ts` compaction
  error contracts; `packages/agent/src/harness/compaction/compaction.ts`
  summary-request scheduling and content extraction.

## Summary-safe request content for branch summarization and compaction (2026-08-13)

### What changed

- `packages/agent/src/harness/compaction/utils.ts` exports
  `contentTextForSummary()`, which filters provider-native replay blocks from a
  copy before handing content to pi-ai's portable `contentText()`; the
  provider-native blocks stay on the persisted assistant message for
  same-provider replay, and the persisted message is never cast or mutated.
- Wired into every summarization request path:
  `packages/agent/src/harness/compaction/branch-summarization.ts`
  (`generateBranchSummary`), `packages/agent/src/harness/compaction/compaction.ts`
  (`generateSummaryWithUsage`, `generateTurnPrefixSummary`), and
  `serializeConversation()`'s user/assistant/tool-result extraction in
  `packages/agent/src/harness/compaction/utils.ts`.
- `findCutPoint()` in `packages/agent/src/harness/compaction/compaction.ts`
  keeps the last valid cut point when the recent-token budget overshoots the
  newest eligible cut point instead of dropping the compaction (PR #40,
  2026-06-15).
- Consolidates the 2026-08-13 "Summary-safe branch compaction text" record
  under the canonical four-section format.

### Why

- Provider-native replay content must not leak into durable summaries, and a
  token-budget overshoot must still compact rather than leave the session over
  context; both decide request content before any extension sees the payload.

### Why an extension could not handle it

- The summary request content is assembled inside harness compaction helpers
  before coding-agent extensions can inspect or rewrite the session entry
  payload.

### Expected merge conflict zones

- LOW: `packages/agent/src/harness/compaction/utils.ts` around
  `contentTextForSummary()` and `serializeConversation()`;
  `packages/agent/src/harness/compaction/branch-summarization.ts` in
  `generateBranchSummary()` content extraction;
  `packages/agent/src/harness/compaction/compaction.ts` content extraction and
  the `findCutPoint()` overshoot branch.

## 2026-08-13 - Summary-safe branch compaction text

### What changed and why

- Branch summarization and compaction use `contentTextForSummary()` instead of
  the portable-only AI `contentText()` helper.
- Provider-native replay blocks must be filtered while preserving the text that
  belongs in a durable branch summary.

### Why the extension system could not handle this

- Harness compaction constructs the summary request before any coding-agent
  extension can inspect or rewrite the session entry payload.

### Expected merge conflict zones on next upstream sync

- LOW: `harness/compaction/branch-summarization.ts`, in
  `generateBranchSummary()` content extraction.
- LOW: `harness/compaction/utils.ts`, where the summary-safe helper is defined.

## 2026-08-13 - Upstream harness type cleanup

### What changed and why

- Removed an unused compaction image type import and adopted optional-chain narrowing in reducer and session-state
  guards introduced by the upstream harness v2 merge.
- Runtime behavior is unchanged; the edits make the merged harness pass the repository's warning-as-error gate.

### Why the extension system could not handle this

- These are internal harness compiler and lint boundaries, evaluated before any coding-agent extension loads.

### Expected merge conflict zones on next upstream sync

- LOW: harness compaction imports, reducer assistant-entry guards, and session fork-target validation.

## 2026-08-11 - Resolve eligible inactive tools at model call time

### What changed and why

- `AgentLoopConfig.resolveUnknownToolCall` is consulted before the existing unknown-tool result is emitted.
- A host may return a newly activated tool, which then follows the normal argument validation, hooks, execution, and result lifecycle.
- Returning `undefined` preserves the existing `Tool <name> not found` behavior byte-for-byte.

### Why the extension system could not handle this

- Unknown tool names were rejected inside the low-level agent loop before coding-agent tool hooks or extension callbacks ran.

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` next to tool-loop callback configuration.
- LOW: `agent-loop.ts` unknown-tool preparation branch.
- LOW: `agent.ts` loop-config forwarding.

## 2026-08-11 - Windows process-tree kill survives an unresolvable taskkill

### What changed and why

- `harness/env/nodejs.ts`: the Windows branch of the harness `killProcessTree` moved into the exported
  `killWindowsProcessTree`, which walks the ordered launcher list from the new `windowsTaskkillCandidates` export
  (every existing absolute `System32` / `Sysnative` `taskkill.exe`, then the bare PATH-resolved name), runs each with
  `spawnSync` under a 5s timeout, and only degrades to `process.kill(pid)` when no launcher starts at all.
- `spawn("taskkill", ...)` resolves through PATH and reports a failed lookup asynchronously on the child's `error`
  event, so the surrounding `try`/`catch` never observed it. Without a listener Node re-emits ENOENT as an uncaught
  exception, killing the host process instead of the target tree whenever PATH had lost `%SystemRoot%\System32`.
- The kill is synchronous so a caller that tears down and exits in the same tick still terminates its children;
  `spawnSync` also reports a failed lookup on its returned `error` field instead of emitting it. The direct
  `process.kill` stays a last resort because `TerminateProcess` leaves descendants orphaned.
- The same fix lands in `packages/coding-agent/src/utils/shell.ts`; the two harnesses keep independent copies of this
  helper as they already do for `getShellEnv` and bash resolution.

### Why the extension system could not handle this

- The kill runs inside the Node harness's own process supervision, below every extension hook.

### Expected merge conflict zones on next upstream sync

- LOW: the Windows branch of `killProcessTree` and the `node:child_process` / `node:fs` import lines in
  `harness/env/nodejs.ts`.

## 2026-08-10 - Refresh server-fallback policy between tool turns

### What changed and why

- `AgentLoopTurnUpdate` can now replace `abortServerSideFallback` together with the model and thinking level before
  the next provider request in an active run.
- `agent-loop.ts` applies the refreshed value when rebuilding its request config after tool execution. Previously the
  loop snapshotted the option at run start, so a host that changed models mid-turn could send the next request with
  the prior model's server-fallback policy.
- An explicit `false` remains authoritative because the update uses nullish fallback rather than truthiness.

### Why the extension system could not handle this

- The provider options object is owned and snapshotted inside agent-core before extensions observe the next request;
  only the loop can replace request policy between tool turns.

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` `AgentLoopTurnUpdate`.
- LOW: `agent-loop.ts` next-turn config replacement.

## 2026-08-09 - Recover invisible text-protocol assistant stops

### What changed and why

- Empty-assistant recovery now covers every model selected for text-tool-call recovery or configured with a text tool
  format, expanding the previous Kimi-only gate to Claude, ANTML, Hermes, morph-XML, YAML-XML, Gemma delimiters, and
  other configured text protocols. A `stop` turn with no visible text and no tool call is discarded and retried once;
  a second invisible stop retains the existing explicit `Model returned an empty response twice` failure.
- Both the completed-message gate and the first-visible-event gate use pi-ai's shared Unicode visibility predicates.
  Unicode format-only deltas such as the U+200B block emitted by the Apitopia Kimi-K3 gateway remain buffered, so
  malformed thinking/tool-marker events from the discarded attempt never reach subscribers.
- The approved universal gate was narrowed after the full-suite audit: buffering all model streams suppressed ordinary
  thinking updates, changed provider stream-start/idle-timeout semantics, and prevented coding-agent TTSR from
  observing and aborting malformed reasoning streams. Plain native-protocol models therefore keep direct streaming,
  while every model exposed to the text-protocol failure mode receives bounded recovery.
- Healthy visible text, tool calls, and non-`stop` terminal states retain their existing pass-through behavior.

### Why the extension system could not handle this

- Provider stream buffering and retry happen inside agent-core before message-update events are forwarded or an
  assistant turn is committed; extensions cannot retract leaked attempt-one events or replace the committed turn.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `empty-assistant-recovery.ts` visibility checks and stream wrapper gate.
- LOW: `agent-loop.ts` at the recovery wrapper call site.

## Default StreamFn compatibility for empty-assistant recovery (2026-07-30)

### What changed

- `packages/agent/src/stream-fn.ts` re-exports `withEmptyAssistantRecovery`
  from `packages/agent/src/empty-assistant-recovery.ts`, keeping the injectable
  stream-function seam (`setDefaultStreamFn`/`getDefaultStreamFn`) the single
  place a host wires streaming.
- `packages/agent/src/agent-loop.ts` wraps the resolved stream function with
  `withEmptyAssistantRecovery(requestConfig.model, streamFunction)` before each
  provider request, so bounded empty-assistant recovery applies to every
  StreamFn in effect — explicitly passed or installed as the host default —
  without hosts importing the wrapper from a deep path.
- Landed with the Kimi empty-response retry; the 2026-07-30 and 2026-08-09
  recovery entries remain the accurate behavioral history and are preserved
  unchanged.

### Why

- Recovery must compose with host-installed default stream functions (the
  browser-safe core ships no provider catalog of its own), and the re-export
  keeps the loop importing its stream plumbing from one module.

### Why an extension could not handle it

- The wrapper sits between the loop and the provider stream, buffering and
  retrying empty assistant responses before message-update events reach
  subscribers or a turn is committed; extensions cannot retract leaked
  attempt-one events or replace the committed turn.

### Expected merge conflict zones

- LOW: `packages/agent/src/stream-fn.ts` re-export line;
  `packages/agent/src/agent-loop.ts` at the recovery wrapper call site.

## 2026-07-30 - Bound empty Kimi assistant responses

### What changed and why

- Kimi-family provider streams that finish with `stop` but contain neither non-empty visible text nor a tool call
  are discarded before turn commitment and retried once with the same request.
- A successful second attempt is the only assistant turn committed and carries an
  `empty_assistant_response_recovery` diagnostic. A second empty response becomes a visible error instead of
  ending the session silently or looping indefinitely.
- Error, aborted, refusal, length, and tool-call turns keep their existing behavior. The stream gate buffers only
  Kimi responses before their first visible text/tool signal, avoiding reasoning-stream regressions for other
  model families.
- Coverage: agent-loop tests pin one-shot recovery, bounded failure, terminal-state preservation, and tool
  execution. The real CLI mock-loop scenario proves the user-visible recovery path.

## 2026-07-29 - Bounded provider stream start (streamStartTimeoutMs)

### What changed and why

- `agent-loop.ts` bounds the wait for the FIRST provider stream event with a new optional
  `AgentLoopConfig.streamStartTimeoutMs`. Providers emit their first event only once the HTTP
  response begins, so a dead upstream that accepts a request and never answers was previously
  bounded only by `timeoutMs` (the idle timeout, default 5 minutes): every attempt froze the
  session for 300s with zero events, zero usage, and nothing persisted. Observed in a donated
  5h session log where the same session hung deterministically on reopen while new sessions
  worked. After the first event arrives the idle bound governs as before.
- The failure message `Provider stream start timed out after <ms>ms (raise streamStartTimeoutMs — retry.provider.streamStartTimeoutMs in senpi settings; 0 disables)` deliberately contains
  "timed out" so the existing retryable-error classifier (`isRetryableErrorMessage`) retries
  it instead of dead-ending the session; the request-local abort controller tears the dead
  request down exactly like an idle timeout.
- `agent.ts` plumbs `streamStartTimeoutMs` through `AgentOptions`/`Agent` into the loop config.

### Files modified

- `agent-loop.ts`
- `agent.ts`
- `types.ts`
- `../test/agent-loop-stream-start-timeout.test.ts`

## 2026-07-29 - Continuation-scoped queue and timeout controls

### What changed and why

- `Agent.continue()` and `continueWithQueuedMessages()` accept continuation-only options that defer queued input from
  the first provider request and override both stream idle and stream-start bounds for that request without mutating
  the agent's configured defaults. Later requests in the same run restore the configured bounds; after the first
  retry event, the configured idle timeout also governs inter-event gaps so healthy silent reasoning is not capped.
- Queue-first recompaction recovery takes precedence over deferral: the selected queued message is the continuation
  input, while first-request timeout overrides still apply.
- The core run lifecycle intentionally parks queued steering and follow-up input after terminal error or abort
  responses until an external retry/compaction owner or a later admitted prompt consumes it. This stop-reason policy
  is distinct from `suppressQueuedMessageDrain()`, which transfers one active run's post-`agent_end` ownership.
- Coding-agent retries use these controls after a silent provider stream so a doomed retry cannot consume newly
  queued user input and a later ordinary provider request automatically returns to the configured timeout.

### Files modified

- `agent.ts`
- `types.ts`
- `agent-loop.ts`
- `../test/agent.test.ts`
- `../README.md`

### Why the extension system could not handle this

- Provider-request queue polling, event-reader timeout selection, and post-run native queue draining happen inside
  agent core before coding-agent extensions can safely claim or restore that work.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent.ts` continuation APIs/config creation and active-run lifecycle queue draining.
- MEDIUM: `agent-loop.ts` provider-request timeout selection inside `runLoop()`.

## 2026-07-27 - End classifier-refused turns before tool execution

### What changed and why

- `assistant-terminal-state.ts` owns terminal assistant classification, including typed classifier refusals;
  `agent-loop.ts` now consults it before any partial tool calls are executed. Anthropic can emit a tool call and
  then finish the same stream with a refusal/sensitive stop; treating the message as ordinary `toolUse` previously
  ran the refused call and continued on the same model.
- The terminal `agent_end` lets the coding-agent retry/fallback controller immediately apply its configured pinned
  refusal fallback.

## 2026-07-23 - Session-owned post-agent_end queue drain suppression

### What changed and why

- `Agent` now exposes `suppressQueuedMessageDrain()` for the active run. It stops only the lifecycle-owned
  post-`agent_end` steering/follow-up drain, retaining both queues without aborting the run signal.
- `Agent` now exposes `continueWithQueuedMessages()` so compaction recovery can deliver retained steer/follow-up input
  when custom context leaves the transcript tail non-assistant.
- The coding-agent compaction admission gate uses this ownership transfer for required recovery. Real user aborts
  continue to abort the active signal and retain the normal terminal semantics.
- Scheduled continuation can revalidate a model changed by `session_compact`, recompact if required, and then deliver
  retained queues without inventing an empty continuation turn.

### Files modified

- `agent.ts`
- `../test/agent.test.ts`

### Why the extension system could not handle this

- Native queue draining and active-run signal ownership occur inside `Agent` after event subscribers return.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent.ts` active-run lifecycle and post-`agent_end` queue draining.

## 2026-07-23 - uuidv7 concurrency refutation + immutable launch profile

### What changed and why

- `harness/session/uuid.ts`: the inlined UUIDv7 implementation uses a synchronous counter over module
  state. A concurrency refutation test (`test/uuid-concurrency.test.ts`) records that N interleaved
  async tasks calling `uuidv7()` produce unique, monotonic-per-timestamp ids — the synchronous counter
  makes uniqueness hold under interleaving (no `await` between timestamp read and counter increment).
  This is a recorded refutation WITH a test, not a bare assertion; it documents that the existing
  synchronous-counter design is correct under interleaving so future refactors do not "fix" a
  non-bug by adding an async lock that would change id ordering.
- `core/agent-session-runtime.ts` (`CreateAgentSessionRuntimeFactory`, `:35,74-242,411`): runtime
  construction now carries an immutable per-open launch profile
  `{ permissionPreset, creationModel, initialThinkingLevel, cwd }`. The profile is retained by
  `AgentSessionRuntime` and survives `new_session`/`switch_session`/reload unless the command
  explicitly changes it. This carries per-session `cwd`, permission-preset, model selection, and
  thinking level with identical semantics to today's spawn flags, without `main.ts` closing over
  process-level parse.

### Files modified

- `harness/session/uuid.ts` (no production change; refutation test only)
- `../test/uuid-concurrency.test.ts` (new)
- `core/agent-session-runtime.ts`

### Why the extension system could not handle this

- The UUIDv7 counter and the launch-profile retention live inside `pi-agent-core` before coding-agent
  extensions or mode renderers participate; the profile must be carried by the runtime the session
  registry constructs inside `runWithProviderScope`.

### Expected merge conflict zones on next upstream sync

- LOW: `harness/session/uuid.ts` (unchanged production code; test is fork-only).
- MEDIUM: `core/agent-session-runtime.ts` around `CreateAgentSessionRuntimeFactory` options.
## 2026-07-17 - Truncation-recovery flagged-call failure and proxy payload

### What changed and why

- A tool call that the text tool-call middleware could only partially recover now arrives at the
  agent loop carrying `incomplete: true`. Previously a truncated text-protocol call could be silently
  dropped, leaked as raw markup, or executed from stale arguments; the loop had no way to treat a
  partially recovered call as a failure and ask the model to retry.
- `prepareToolCall` now produces an immediate error outcome for any flagged call (an `isError` tool
  result carrying a retry diagnostic such as "Re-issue the tool call"), skipping
  validation/hooks/execution while preserving source-order event emission in the same scheduler. The
  existing native `length` stop rule is preserved for provider-native streams; only the text-middleware
  wrapper converts a terminal `length` to `toolUse` when tool-call activity was finalized.
- The flagged error result keeps the inner loop alive (`failToolCallsFromTruncatedMessage` already
  returns `{ terminate: false }`), so the loop streams another assistant turn and the model re-issues
  the truncated call — the retry contract.
- Flagged-call diagnostics always append `Re-issue the tool call with complete arguments.` to parser-provided error messages without duplicating a final period.
- `proxy.ts` `toolcall_end` wire event gains an optional full `toolCall` payload so a flagged call
  (which emits no argument deltas) can still be delivered to clients. The client prefers the payload
  and falls back to delta reconstruction; against an older server that omits it, the client degrades
  to the legacy delta-only path. The producing server is external; the in-repo deliverable is the
  wire type, the client merge, and the skew-degradation tests.

### Files modified

- `agent-loop.ts`
- `proxy.ts`
- `../test/agent-loop.test.ts`, `../test/proxy-events.test.ts`

### Why the extension system could not handle this

- Flagged-call routing into an immediate error outcome, the retry decision, and the proxy wire type
  all live inside `pi-agent-core` before coding-agent extensions or mode renderers participate.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `agent-loop.ts` around `prepareToolCall` and `failToolCallsFromTruncatedMessage`.
- LOW: `proxy.ts` around the `toolcall_end` wire event and client reconstruction.

## 2026-07-20 - Terminating queue recovery survives compaction preparation

### What changed and why

- `agent-loop.ts` re-polls a terminating turn's drained steering or follow-up queue after next-turn preparation, restoring it on preparation failure or abort and continuing only with work that remains queued.
- This keeps queued recovery input owned by agent-core while coding-agent compaction settles, preventing a queued prompt from being dropped or dispatched from stale history.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent.test.ts`

### Why the extension system could not handle this

- Queue draining, restoration, and next-turn preparation run inside the agent loop before coding-agent extensions can observe or safely requeue the consumed messages.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `packages/agent/src/agent-loop.ts` around terminating tool batches, queue polling, and next-turn preparation.

## 2026-07-06 - Stream idle timeout aborts the dangling provider request

### What changed and why

- The idle-timeout reader rejected the turn but left the underlying provider request dangling:
  `iterator.return()` is a no-op on `EventStream`, so a silently dead connection (network drop + reconnect) kept its
  socket and stream alive forever.
- The agent loop now owns a per-request `AbortController`, propagates caller aborts into it through a single listener,
  and aborts it with `StreamIdleTimeoutError` when the reader times out, tearing the request down so auto-retry can
  recover the turn.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- Stream lifetime and abort propagation live inside the agent loop's provider-request plumbing, upstream of any
  coding-agent extension hook.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `packages/agent/src/agent-loop.ts` around provider stream creation, idle-timeout reading, and abort-signal
  wiring.

## 2026-07-02 - Upstream harness timeout and compaction serialization sync

### What changed and why

- Accepted upstream harness changes for rejecting invalid/non-positive Node timeouts and serializing split-turn compaction
  summary requests.
- This keeps the fork aligned with upstream runtime validation and prevents single-concurrency providers from receiving
  overlapping compaction-summary generations.

### Files modified

- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/env/nodejs.ts`

### Why the extension system could not handle this

- Timeout validation and harness compaction scheduling happen inside shared agent-core helpers before coding-agent
  extensions or mode renderers participate.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/harness/env/nodejs.ts` around timeout parsing and validation.
- LOW: `packages/agent/src/harness/compaction/compaction.ts` around summary request scheduling.

## 2026-05-15 - Tool abort loop termination

### What changed and why

- Stopped the core agent loop immediately after a tool batch finishes under an aborted signal.
- This prevents a tool-level abort result from continuing into `prepareNextTurn`, steering queue polling, follow-up queue
  polling, or another provider request.
- This closes the remaining abort path not covered by terminal assistant stream event normalization.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The decision to poll queued steering after tool execution happens inside the core loop before extensions can safely
  restore UI/editor queue state.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` after `turn_end` emission in `runLoop()`.

## 2026-05-15 - Upstream harness refactor sync preservation

### What changed and why

- Preserved the fork's ES2021 diagnostic compatibility while accepting upstream's result-based harness/environment refactor.
- Kept stream option patching on `Object.prototype.hasOwnProperty.call` instead of `Object.hasOwn`.
- Kept harness error `cause` capture without relying on two-argument `Error` construction.

### Files modified

- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/types.ts`

### Why the extension system could not handle this

- These are exported harness primitives and internal option-merging helpers that are evaluated before coding-agent
  extensions can participate.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/agent-harness.ts` around `applyStreamOptionsPatch()`.
- `packages/agent/src/harness/types.ts` around harness error constructors.

## 2026-05-15 - Compaction summary metadata

### What changed and why

- Added optional `details` metadata to the harness `CompactionSummaryMessage` type.
- This keeps the shared agent-core message augmentation compatible with coding-agent compaction summaries that carry
  provider-native compaction route details for TUI rendering and replay.

### Files modified

- `packages/agent/src/harness/messages.ts`

### Why the extension system could not handle this

- This is exported type metadata in the shared harness message model. Extensions can populate compaction details, but they
  cannot alter the core `CustomAgentMessages` declaration merge.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/harness/messages.ts` around `CompactionSummaryMessage`.

## 2026-05-12 - Abort terminal event normalization

### What changed and why

- Normalized terminal assistant stream messages in `agent-loop.ts` so the event-level `reason` is authoritative for
  `done`/`error` events.
- This prevents an abort event with a stale assistant `stopReason` from being treated as a normal stop and draining queued
  steering/follow-up messages after the user interrupted the run.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent.test.ts`

### Why the extension system could not handle this

- The stale-stopReason decision happens inside the core agent loop before extensions see a completed turn.
- Extensions can observe abort events after the fact, but they cannot prevent the loop from deciding to continue into
  queued messages.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` around terminal `done`/`error` stream handling.

## 2026-04-05 - Parallel tool completion emission

### What changed and why

- Updated `executeToolCallsParallel()` to finalize prepared tool calls concurrently after sequential preflight.
- This lets `tool_execution_end` and `toolResult` message events appear as soon as each tool finishes instead of waiting behind an earlier slow tool.
- The returned `toolResults` array still stays in assistant source order, which preserves next-turn context ordering and matches existing semantic expectations.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts`
- `packages/agent/README.md`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The scheduling and final result collection logic lives in `@mariozechner/pi-agent-core`, specifically `executeToolCallsParallel()`.
- Coding-agent extensions can observe and mutate tool inputs/results, but they cannot replace the agent loop's internal await/collection strategy or `toolExecution` scheduling behavior.
- The existing builtin `parallel-tool-calls` extension only changes provider payloads (`parallel_tool_calls: true`) and does not control runtime result finalization.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/agent-loop.ts` around `executeToolCallsParallel()`
- `packages/agent/src/types.ts` tool execution mode docs
- `packages/agent/README.md` tool execution behavior description

## 2026-05-11 - Inline harness UUIDv7 generation

### What changed and why

- Replaced upstream harness imports of `uuid/v7` with a local UUIDv7 generator backed by Node's `crypto.randomBytes`.
- This keeps clean package-manager builds working without adding a new direct `uuid` dependency to `@earendil-works/pi-agent-core`.

### Files modified

- `packages/agent/src/harness/session/uuid.ts` (current location; the generator originally landed in the since-restructured session repo/storage files)

### Why the extension system could not handle this

- The failing imports live inside the agent harness session storage implementation and run before any coding-agent extension can intercept them.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/session/uuid.ts`
- its importers `packages/agent/src/harness/session/{repo-utils,memory-storage,jsonl-storage}.ts` around session/entry id creation.

## 2026-05-11 - Harness ES2021 diagnostic compatibility

### What changed and why

- Replaced `ErrorOptions`/two-argument `Error` construction in `FileError` with an equivalent local `{ cause }`
  option stored on the class.
- Replaced `Object.hasOwn` with `Object.prototype.hasOwnProperty.call` in the stream option patch helper.
- This keeps the upstream harness behavior intact while avoiding diagnostics in environments that type-check the package with
  ES2021 library declarations.

### Files modified

- `packages/agent/src/harness/types.ts`
- `packages/agent/src/harness/agent-harness.ts`

### Why the extension system could not handle this

- These are type-level compatibility fixes in exported harness primitives and internal option-merging code that run before
  coding-agent extensions are involved.

### Expected merge conflict zones on next upstream sync

- `packages/agent/src/harness/types.ts` around `FileError` construction.
- `packages/agent/src/harness/agent-harness.ts` around `hasOwn()`.

## 2026-07-22 - Per-thinking-block stream timing

### What changed and why

- `agent-loop.ts` now stamps each streamed thinking block's `startedAt` and `endedAt` with best-effort receipt timestamps. Every thinking update is restamped because thinking projection middleware may replace the block object between events; terminal completion, error/abort, reader failure, and normal stream fallthrough all close unfinished blocks before emitting the final message.

### Files modified

- `packages/agent/src/agent-loop.ts`
- `packages/agent/test/agent-loop.test.ts`

### Why the extension system could not handle this

- The timestamps must be attached at the agent loop's provider-event choke point, before extensions receive message updates or terminal messages.

### Expected merge conflict zones on next upstream sync

- LOW: `packages/agent/src/agent-loop.ts` streaming event switch and terminal response paths.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/agent/src/harness/compaction/branch-summarization.ts`: upstream body, but the summary text comes from the fork's `contentTextForSummary` (summary-safe content extraction) instead of `contentText`.
- `packages/agent/src/harness/compaction/compaction.ts`: upstream body plus the fork's `dropFailedAssistantTurns` accounting in `estimateContextTokens` (a counted set so failed turns are neither estimated nor used as the last usage anchor, indices still relative to the input array), the fork cut-point fallback to the last candidate when no cut point clears the budget, and `contentTextForSummary` at both summary sites.
- `packages/agent/src/harness/env/nodejs.ts`: upstream capture/spill rewrite plus the fork's shell hardening: `windowsTaskkillCandidates`/`killWindowsProcessTree` (synchronous `spawnSync` over every existing System32/Sysnative `taskkill.exe` before the PATH name, direct kill as last resort), promise-returning `onUpdate` observers tracked and awaited with a 5 s `NORMAL_CALLBACK_SETTLEMENT_TIMEOUT_MS` bound, and `callback_error` carrying the raw rejected value as `cause`.
- `packages/agent/src/harness/messages.ts`: `convertToLlm` ends with the fork's `dropFailedAssistantTurns` so failed provider turns never replay, and `CompactionSummaryMessage` keeps the fork `details?: unknown` field.
- `packages/agent/src/harness/runtime/drive/retry.ts`: `retryNotBefore` widens its policy `Pick` to include `random` so the fork's injectable jitter source reaches `retryDelayMs` from the runtime retry path (the fork jitters before the `maxAgentDelayMs` cap, D-M).
- `packages/agent/src/harness/tools/edit.ts`: upstream signature and mutation-queue plumbing plus the fork `postMutate` seam (`runPostMutate` inside the same queue slot, re-read on `fileMayHaveChanged`, diff and patch recomputed against the committed bytes, `rereadNote`, `appendPostMutateNote`).
- `packages/agent/src/harness/tools/write.ts`: same `postMutate` seam; the success text stays `Successfully wrote to <path>` with the hook note appended.
- `packages/agent/src/harness/types.ts`: `ShellExecOptions.onUpdate` returns `void | PromiseLike<void>` so awaited output callbacks survive; `FileError`/`ExecutionError`/`CompactionError` expose a `readonly cause?: unknown` and `ExecutionError` accepts a non-Error cause; `getOrUndefined` keeps the fork nullable-normalizing signature (no caller of upstream's Result-unwrapping overload on either side).
- `packages/agent/src/harness/utils/shell-output.ts`: `ShellCaptureOptions.onChunk` may return a promise and its settlement is returned to the environment so a rejection becomes `ExecutionError("callback_error")` instead of an unhandled rejection.
- `packages/agent/src/index.ts`: adds the fork export line for `EMPTY_TOOL_USE_DEMOTION_DIAGNOSTIC` and `ProviderRetryWatchdogAbortError` from `assistant-terminal-state.ts`.
- `packages/agent/src/types.ts`: keeps the fork loop surface: `thinkingSelection`, `abortServerSideFallback`, `cursorExecHandlers` (with the run-signal factory form), `streamStartTimeoutMs`/`initialRequestTimeoutMs`/`initialRequestStreamStartTimeoutMs`, `restorePendingMessages`, `removedToolHints`, `resolveUnknownToolCall`, wave-based parallel tool scheduling docs, `AgentToolResult.isError`, `reasoningBaseline` and the `@earendil-works/pi-agent-core` module-augmentation example.

### Why

- The fork's loop contract (failed-turn dropping, Astra prompt-cache prefix stability, Cursor exec channel, stream-start watchdogs, post-mutate hooks, hardened Windows process-tree kills, awaited output observers) has to survive upstream's runtime/session generation; these files are the living boundaries where that behavior is expressed.

### Why an extension could not handle it

- Context estimation, message projection, tool execution order, error `cause` typing and the harness's public option types are core wire and type contracts consumed by every lane; an extension cannot interpose on them.

### Expected merge conflict zones

- HIGH: `packages/agent/src/harness/env/nodejs.ts` capture pipeline and Windows kill path; `packages/agent/src/types.ts` `AgentLoopConfig`/`AgentTool` interfaces.
- MEDIUM: `estimateContextTokens`/`findCutPoint` in `compaction.ts`; `execute` bodies of `tools/edit.ts` and `tools/write.ts`; `ShellExecOptions` in `harness/types.ts`.
- LOW: `convertToLlm` tail in `harness/messages.ts`; `retryNotBefore` signature; the `assistant-terminal-state.ts` export line in `index.ts`.
