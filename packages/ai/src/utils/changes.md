## 2026-10-30 - Keep-alive timeout is a provider stream stall (senpi#4608)

### What changed

- `packages/ai/src/utils/retry.ts`: `PROVIDER_STREAM_STALL_ERROR_PATTERN` and `PROVIDER_STALL_PHASES` recognize `Provider stream sent only keep-alives and timed out after <n>ms (...)`; users read "kept the connection alive but sent no response", with `retry.provider.keepAliveTimeoutMs` as the setting to raise.

### Why

- The new bound must take the same same-model retry and fallback path as the other stream bounds, and explain itself in plain words.

### Why an extension could not handle it

- The stall classifier is the shared retry gate.

### Expected merge conflict zones

- LOW: the stall pattern alternation and the phase table.

## 2026-10-27 - Explicit producer-time seed frontier (part of #4272)

### What changed

- `packages/ai/src/utils/assistant-capture.ts` carries `nextOffset` on block starts; frozen-value construction moves to `packages/ai/src/utils/assistant-capture-record.ts`.
- `packages/ai/src/utils/assistant-seed-frontier.ts` accepts only zero or full UTF-16 seed length and supplies typed missing/invalid frontier errors.

### Why

- Identical nonempty seeds previously hid whether subsequent deltas replayed from zero or continued at the seed length.

### Why an extension could not handle it

- `packages/ai/src/utils/assistant-capture.ts`, `packages/ai/src/utils/assistant-capture-record.ts`, and `packages/ai/src/utils/assistant-seed-frontier.ts` own producer-time capture and its internal consumer contract, before extension delivery.

### Expected merge conflict zones

- `packages/ai/src/utils/assistant-capture.ts`, `packages/ai/src/utils/assistant-capture-record.ts`, and `packages/ai/src/utils/assistant-seed-frontier.ts`.

## 2026-10-26 - Provider error bodies are classified raw and kept redacted at the stream boundary (senpi#4282)

### What changed

- `provider-error.ts` (new): `isModelConfigError` (every quantifier bounded) and `sanitizeProviderErrorMessage`, which classifies the raw `errorMessage` of an error message (`stopReason: "error"`) first, sets `errorCause: { type: "model_config", model }` when it names a model the route does not serve, then keeps only the redacted text of every provider error.
- `secret-redaction.ts` (new): `redactSecrets` and `redactCredentialShapes`, the one-pass state machine. One left-to-right pass reads the text as alternating tokens and delimiters; each token is classified from its own characters and the delimiters beside it, with index arithmetic only and no regular expression. The whole value of a strict name (password, secret, authorization, bearer) is read forward to its closing quote (at the opening quote's escaping depth) or, when bare, to whitespace, `,`, `;`, `&`, a quote or `<`, and the scan resumes after it.
- `secret-lexer.ts` (new): character classes, percent escapes and HTML entities read as what they encode, the token and delimiter units, and the forward scans that find where a quoted or bare value ends. The shared logical-unit reader collapses canonical percent layers in one forward walk, then repeatedly percent-decodes a 64-character window to a fixpoint, retaining source offsets. Independently encoded percent signs and hex digits, mixed depths and either hex case use the same semantics; an unresolved window returns a typed refusal and the scanner redacts the remaining suffix conservatively. Work is linear: canonical prefixes are consumed once and every remaining window has constant work and storage. Both exported redactors use the same scanner and shape classifier; shapes mode deliberately interprets neither credential names nor URL passwords. JWT segment dots and URL authority slashes use logical units too. Scaling tests count scanner character reads through both exports instead of load-sensitive wall time.
- `secret-classifier.ts` (new): credential words (a name is normalized: lowercase, camelCase split, trailing digits and `value`/`val`/`id` qualifiers stripped), known key prefixes and JWTs. A prefix or JWT is recognized wherever a word starts inside a token (after `/`, `+`, `~`, `-`, `.`, `%`, including percent-encoded token punctuation), never inside a word; each prefix check is bounded work, and a failed JWT candidate skips to its first `.`, so every segment is walked at most three times.
- `event-stream.ts`: `AssistantMessageEventStream.push` and `end` run `sanitizeProviderErrorMessage` on every partial, error and final message, so no consumer of any provider stream sees a raw provider error body.
- `retry.ts`: `isRetryableAssistantError` returns false for a `model_config` cause.
- `secret-lexer.ts`: a percent-window refusal requires an unresolved percent/hex run contiguous to the window edge; a space or non-hex literal ends that dependency, so printf and SQL percent text stays readable. Windows without a percent followed by a hex digit skip fixpoint-buffer allocation and decoding passes.
- `secret-classifier.ts` and `secret-redaction.ts`: a single known key's redacted span ends at its credential alphabet boundary, preserving a following path separator or filename suffix. If another credential starts anywhere after the first start, even inside its alphabet or behind a word character, the whole remaining token is conservatively redacted. Hook diagnostics retain the source filename around a single PAT. The suffix matrix covers every prefix alias and JWT, slash, dot, colon, query/form separators, underscore, hyphen, end of string, a word character and three joined credential families in EN/KO prose, paths, URLs and userinfo through both public redactors.

### Why

- A redaction applied at `message_end` left the raw body in `message_start`/`message_update` events published before it; every provider builds its error through this stream, so it is the one place where the body enters our objects.
- Regex redaction was quadratic on shaped input twice in review (a keyword repeated over one name run, then the JWT rule on `eyJ-` runs: 1 MB took about 52 s), synchronously inside `push`; it also mangled names that only contain a credential word, missed numbered or qualified names, and missed cookie pairs after a short first value. A token-wise pass is linear by construction.

### Why an extension could not handle it

- The provider stream class and the retry classifier are core pi-ai code that every provider and the agent loop share.

### Expected merge conflict zones

- LOW: the `AssistantMessageEventStream` class body in `event-stream.ts`; the top of `isRetryableAssistantError`.

## 2026-10-26 - Relay hints and consistent replaced terminals (senpi#4307, part of #4272)

### What changed

- `assistant-capture.ts` (fork-only): `CaptureHint.carried` makes a push relay a source capture's block facts, with
  usage and metadata from the relaying stream; `null` records nothing. A start whose block is not appended yet records
  nothing. `carryAssistantCapture` with a replaced terminal takes the new terminal's usage and message and adds every
  scalar that differs from the source terminal to its metadata. `AssistantCapture.rewrittenFrom` (set through
  `CaptureHint.rewrittenFrom` on a terminal and kept when the terminal is re-carried) names the first index from which
  earlier block records no longer name the terminal's blocks (block index/identity only). The terminal message always
  wins for content: readers replace each block's content from the terminal (or the block's end event), never
  append-only from live records.

### Expected merge conflict zones

- None upstream: the file is fork-only.

## 2026-10-26 - Capture vocabulary for replaced signatures, redaction and late names (senpi#4285, part of #4272)

### What changed

- `packages/ai/src/utils/assistant-capture.ts` (fork-only): `message_block_metadata` gains `thinkingSignature` and
  `textSignature` (replacements, beside the appending `thinkingSignatureDelta`), `redacted` and `name`;
  `pushAssistantSignature` records a changed text/thinking signature and `pushAssistantCompleteBlock` records a block
  appended complete with no event as an insert and an end sharing one frozen copy.

### Why

- Google and Devin replace signatures rather than append them, Bedrock redacts a block mid-stream and Devin can name
  a tool after its start; the S02a-1 vocabulary only appended signatures.

### Why an extension could not handle it

- The progress records are internal to the provider stream's ordered queue.

### Expected merge conflict zones

- None upstream: the file is fork-only.

## 2026-10-25 - Assistant streams capture block seeds at emission and keep one ordered progress lane (senpi#4277, part of #4272)

### What changed

- `packages/ai/src/utils/event-stream.ts`: `EventStream` keeps one ordered queue whose entries are public events or
  internal progress records. Ordinary iteration yields only public events with the same microtask timing as before:
  a queued progress record is skipped in the same `next()` call, and a waiting reader that receives one keeps
  waiting. `AssistantMessageEventStream` takes `{ captureBlocks }`; with it, `push(event, hint?)` freezes the event's
  capture carrier before queuing. Every instance registers a progress writer; a records reader is registered only
  when the class does not replace `[Symbol.asyncIterator]`. Ordinary iteration drops each event's carrier as it is
  dequeued, so a wrapper that reads that way can only lose controls, never forward wrong ones. `done` is now
  `protected`; `mapIterator` and `enqueueProgress` are new protected members.
- `packages/ai/src/utils/assistant-capture.ts` (fork-only, new): the carrier and record vocabulary. Carriers live in
  a `WeakMap` keyed by the event object (never enumerable, never serialized) and hold frozen copies: usage, changed
  message metadata, the public block at start/end (provider scratch and symbols removed), the exact raw argument
  prefix the adapter emitted, UTF-16 coverage and delta offsets, and the parse frontier `parsedThrough`.
  Progress records are `message_block_state` (native insert/end), `message_block_metadata` (changed fields only) and
  `message_tool_arguments_reset` (authoritative raw replacement). `assistantRecords` reads records;
  `assistantEvents` reads events and hands each record to a callback as it is read.

### Why

- Provider events carry the shared live partial and the queue held references, so a seed read when a consumer
  resumed could already contain later bytes, and native insertions/ends happened with no event at all. The facts
  have to be frozen when the producer emits them, and native-only transitions need their own ordered lane
  (R3.C6.2; contract ruling 05, decisions D1-D5).

### Why an extension could not handle it

- Capture has to run inside the producer's `push`, before the event is queued; extensions only see events after
  the consumer resumes, when the live partial may already be ahead.

### Expected merge conflict zones

- MEDIUM: `EventStream` queue and iterator internals (`#queue` entry type, `push`/`deliver`, `mapIterator`,
  `FifoQueue.prepend`) and the `AssistantMessageEventStream` constructor, `push` and iterator overrides.

## 2026-10-25 - Preserve protocol-owned tool arguments (senpi#4191)

### What changed

- `packages/ai/src/utils/validation.ts`: accepts a schema-bound protocol validator before the existing coercion path.
- `packages/ai/src/utils/tool-argument-validator.ts`: stores protocol validators without serializing them into provider requests.
- Protocol validation preserves AJV error paths, required-property names, messages, and keywords so the model can correct its call without echoing argument values.
- `packages/ai/src/utils/tool-argument-coercion.ts`: owns the unchanged primitive coercion extracted from `packages/ai/src/utils/validation.ts`.
- `packages/ai/src/utils/tool-schema-compat.ts`: documents provider adaptation as a separate, potentially lossy wire step.

### Why

- `packages/ai/src/utils/validation.ts`: modern MCP must validate and send the arguments the model produced, rather than repair them through legacy coercion.
- `packages/ai/src/utils/tool-schema-compat.ts`: an object-only provider's schema restrictions must not weaken MCP's source schema or rewrite dispatched arguments.

### Why an extension could not handle it

- `packages/ai/src/utils/validation.ts`: validation runs before an extension tool's execute callback.
- `packages/ai/src/utils/tool-schema-compat.ts`: provider wire conversion occurs after extensions supply their tool definitions.

### Expected merge conflict zones

- `packages/ai/src/utils/validation.ts`: the argument-validation entry and primitive-coercion import.
- `packages/ai/src/utils/tool-schema-compat.ts`: the module-level documentation.

## 2026-10-22 - Extract the configuration reference error without behavior changes (senpi#3858)

### What changed

- `packages/ai/src/utils/config-reference-error.ts`: holds the unchanged `ConfigReferenceError` and `ConfigReferenceReason`, moved from `config-reference.ts`.
- `packages/ai/src/utils/config-reference.ts`: imports and re-exports them, so its public entry keeps the same API.

### Why

- Lets the auth resolution path raise the named error without loading the compiled reference schemas.

### Why an extension could not handle it

- The credential pool raises this error before extension processing.

### Expected merge conflict zones

- LOW: the import and re-export at the top of `packages/ai/src/utils/config-reference.ts`.

## 2026-10-21 - Shared configuration reference object grammar (senpi#3858)

### What changed

- `packages/ai/src/utils/config-reference.ts`: exact single-key `$file`, `$env`, and flat `$concat` schemas and runtime unions; named `ConfigReferenceError` and a validator for explicitly declared string-value slots.

### Why

- Auth, model configuration, and MCP must agree on which objects are references without interpreting opaque JSON or changing legacy strings.

### Why an extension could not handle it

- The credential pool and configuration loaders validate these values before extension processing.

### Expected merge conflict zones

- LOW: new standalone shared contract.

## 2026-10-20 - Keep Claude's spent-window reset in provider diagnostics (senpi#3825)

`provider-diagnostic-sources.ts` adds `resetsAt` to a classified quota/rate-limit error from Claude's unified 5h/7d response headers. Only spent windows with future numeric resets contribute, and the latest spent window wins so a goal cannot wake while another cap still blocks it. Authentication and unknown errors do not read reset headers. `anthropic-provider-diagnostic.test.ts` exercises the real adapter against HTTP fixtures.

## 2026-10-21 - reportedCount: absent, null or non-finite provider counts are not reported (senpi#3879)

### What changed

- `packages/ai/src/utils/reported-count.ts` (fork-only): `reportedCount(value)` returns a finite number or undefined; the four adapters that parse a reasoning count use it.

### Why

- Gateways can send `"reasoning_tokens": null`; a `=== undefined` check let that through as `reasoning: null`, which compaction's retained-message check treats as invalid usage (review of senpi#3884).

### Why an extension could not handle it

- Usage parsing happens inside each adapter's stream.

### Expected merge conflict zones

- None: new file.

## 2026-10-21 - Context readers prefer request measurements (omo#10792)

### What changed

- `packages/ai/src/utils/estimate.ts`: `calculateContextTokens` prefers `Usage.contextUsage`; an explicit unknown measurement returns zero so transcript estimation supplies context.
- `packages/ai/src/utils/overflow.ts`: token-based overflow detection uses request context when present rather than cumulative billed tokens. Error-message classification remains independent. `isRecoverableLength` reads request output when it is measured and falls back to the message output when request context is absent or unknown (`null`), so result-only length stops keep their previous recovery.

### Why

- `packages/ai/src/utils/estimate.ts` and `packages/ai/src/utils/overflow.ts`: the SDK's terminal usage can sum two overlapping full-context requests, exhausting output room or triggering overflow on a conversation that fits.

### Why an extension could not handle it

- `packages/ai/src/utils/estimate.ts` and `packages/ai/src/utils/overflow.ts`: these shared readers run beneath extensions and must understand the additive usage contract for all callers.

### Expected merge conflict zones

- LOW: `packages/ai/src/utils/estimate.ts`, `calculateContextTokens`; `packages/ai/src/utils/overflow.ts`, numeric overflow checks.

## 2026-10-18 - Anthropic compat gains supportsGzipRequestBody (senpi#3643)

### What changed

- `packages/ai/src/utils/prompt-cache-ttl.ts`: `getAnthropicCompat` resolves `supportsGzipRequestBody`, default true only for `api.anthropic.com` (same rule as `supportsWebSearch`).
- `packages/ai/src/utils/gzip-request-body.ts` (fork-only): `withGzipRequestBodies(fetch)` gzips string bodies of 4096+ characters with 0-256 characters of random trailing whitespace (length padding), and on a refused encoding (415, a 400/403 without an Anthropic `req_` request id, or Anthropic's "not valid JSON" 400) resends the same request uncompressed once and keeps that origin uncompressed for the process. A `Request` input's own headers are kept when `init.headers` is absent.

### Why

- Per-provider opt-in keeps proxies and compatible endpoints that cannot decode gzip unaffected; the fallback covers the ones that are opted in by mistake.

### Why an extension could not handle it

- The compat matrix is resolved in `pi-ai` and read by the adapter before any extension hook.

### Expected merge conflict zones

- LOW: the returned object of `getAnthropicCompat`.

## 2026-10-15 - Connection failures classify as network from structured transport codes (senpi#3228)

### What changed

- `packages/ai/src/utils/provider-diagnostic-vocabulary.ts`: `categoryForTransportCode` (closed allowlist: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE, UND_ERR_SOCKET, UND_ERR_CONNECT_TIMEOUT, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT, UND_ERR_CLOSED, and the SDK class names APIConnectionError / APIConnectionTimeoutError -> `network`); `network` is a recognized category.
- `packages/ai/src/utils/provider-diagnostic-sources.ts`: `transportProviderDiagnosticFromError` walks up to 4 links of the `cause` chain reading only `code` (Node's fetch puts it two causes below the SDK error, Bun one), and falls back to the SDK connection error's class name (`name` or `constructor.name`) when no link has a code; never the message. The transport wrappers use it only when the adapter's classifier finds nothing.

### Why

A dropped connection had no category, so clients could not say "check connectivity".

### Why an extension could not handle it

The diagnostic is minted inside the provider transport wrappers in `pi-ai`, below any extension.

### Expected merge conflict zones

- `packages/ai/src/utils/provider-diagnostic-sources.ts`: `awaitProviderTransport` and `iterateProviderTransport`.

## 2026-10-14 - Thinking-mode refusal of a forced tool_choice is retried without it (senpi#3324)

### What changed

- `packages/ai/src/utils/tool-choice-fallback.ts`: the "does not support … tool_choice" refusal pattern accepts "this" and "the" besides "forced", so opencode-go's DeepSeek thinking models' `400 … Thinking mode does not support this tool_choice` is recognised by `isForcedToolChoiceUnsupportedError`. `sendWithForcedToolChoiceFallback` then retries once without `tool_choice`, and does not remember the refusal because it names thinking.

### Why

- The wording matched none of the six refusal patterns, and the message names no tool, so the forced first-turn `todo` choice was fatal. Subagents on `opencode-go/deepseek-v4.1-flash:high` died at launch (0 tool calls, about 1.6 s) whenever the upstream refused (senpi#3324, measured 1 to 2 of 3 launches by the reporter).

### Why an extension could not handle it

- The forced-choice retry runs inside the provider request path that every API shares; no hook sees the refusal before it is thrown.

### Expected merge conflict zones

- LOW: the third pattern in `isForcedToolChoiceUnsupportedError`.

## 2026-10-14 - Anthropic third-party billing rejection is terminal account exhaustion with its own explanation (senpi#3259)

### What changed

- `packages/ai/src/utils/retry.ts`: `ANTHROPIC_THIRD_PARTY_BILLING_MARKER` ("Third-party apps now draw from your extra usage") joins `QUOTA_EXHAUSTION_PATTERNS`, so the 400 classifies as non-retryable account exhaustion; `isAnthropicThirdPartyBillingMessage()` exposes the match.
- `packages/ai/src/utils/provider-failure-description.ts`: `describeProviderFailureForUser()` explains that rejection by billing path: on `anthropic` it names the subscription login ("Anthropic Subscription (Claude Pro/Max)" via `/login`), extra usage at https://claude.ai/settings/usage, or `/model`; on `anthropic-subscription` it offers extra usage or `/model` only.

### Why

- The 400 matched no classifier, so the hard-error fallback walked Opus 5.5 -> 5 -> 4.8 -> 4.6 on the same credential and every hop drew the same rejection (five requests, measured against a local mock), and the user saw only the raw body (senpi#3259).

### Why an extension could not handle it

- Retry classification and the user-facing failure text are shared by every provider and consumed inside the session retry/fallback engine; there is no hook between a provider error and its classification.

### Expected merge conflict zones

- LOW: the tail of `QUOTA_EXHAUSTION_PATTERNS` and the new constant above it in `retry.ts`; the import block and the first branch of `describeProviderFailureForUser()`.

## 2026-10-13 - Every typeless tool-parameter root gets `type: "object"` (senpi#3245, senpi#3250)

### What changed

- `packages/ai/src/utils/tool-schema-compat.ts`: `ensureRootObjectSchema` now adds `type: "object"` to a typeless root
  `allOf` and to an `anyOf`/`oneOf` union that cannot merge because a branch is not an object shape. Both previously
  went out typeless. The combiner stays beside the added type. (A typeless `$ref` root already got `type: "object"`
  before this change.) This supersedes the 2026-08-05 rule in `packages/ai/src/changes.md` that scalar and mixed root
  unions are left typeless.

### Why

DeepSeek and gateways forwarding to it reject every tool whose root parameters schema has no `type`
(`got 'type: null'`), so an unmergeable root union failed every tool call. Tool arguments are always JSON objects and
are validated locally against the original schema, so the stricter wire schema costs nothing in practice.

### Why an extension could not handle it

Tool-parameter normalization runs inside the OpenAI-compatible request builder after extensions hand over tools.

### Expected merge conflict zones

- `packages/ai/src/utils/tool-schema-compat.ts`: the tail of `ensureRootObjectSchema` and its doc comment.

## 2026-10-09 - Restore utils-tracker coverage for upstream-modified paths (senpi#3006)

### What changed

- `packages/ai/src/utils/error-body.ts`: terminal provider errors keep the provider Retry-After; shared quota-exhaustion wording (senpi#2198).
- `packages/ai/src/utils/estimate.ts`: token estimation maintenance on the v0.99.1 sync.
- `packages/ai/src/utils/event-stream.ts`: shared event-stream utility carried through integration repairs.
- `packages/ai/src/utils/overflow.ts`: context-overflow and rate-limit classification — Cursor-only `resource_exhausted` signatures, Kiro payload/context limits, [OI] context-window overflow, and the anthropic-subscription cold-seed refusal.
- `packages/ai/src/utils/pi-user-agent.ts`: the fork adds `forcePiUserAgent(headers)`, which deletes any case-variant `user-agent` header and forces the `User-Agent` to `getPiUserAgent()`; used so Kimi Coding requests always send the shared `pi (<platform>)` User-Agent.
- `packages/ai/src/utils/provider-retry.ts`: structured providerDiagnostic on failed provider turns (senpi#2197).
- `packages/ai/src/utils/text.ts`: request-option and content contract — metadata hooks, affinity, native blocks.
- `packages/ai/src/utils/transcript.ts`: TranscriptContext migration on the v0.99.1 sync.
- `packages/ai/src/utils/uuid.ts`: `fillRandomBytes` falls back to `Math.random` when `globalThis.crypto` is unavailable, with typed-array generics and an extracted `formatUuid()` keeping the time-ordered UUIDv7 generator typecheck-clean.

These files were covered by the parent tracker until senpi#2895 added this nearer tracker without listing them, hiding them from the audit's exact-nearest-tracker rule.

### Why

The repository audit requires every upstream-modified production path to be named by an entry in its exact nearest changes.md tracker. senpi#2895 introduced this tracker and named only the OAuth-refresh modules it touched, so the 9 pre-existing upstream-modified files beneath it lost the coverage the parent tracker had provided and were reported uncovered.

### Why an extension could not handle it

changes.md coverage is fork-owned documentation metadata; no extension or runtime hook can supply it.

### Expected merge conflict zones

- The `fillRandomBytes` random-byte source (the `Math.random` fallback) and the extracted `formatUuid()` in `packages/ai/src/utils/uuid.ts`, against upstream changes to its byte layout.
- The provider-specific pattern/regex lists in `packages/ai/src/utils/overflow.ts` (context-overflow / rate-limit classification), against upstream message-wording changes.
- `forcePiUserAgent` and `getPiUserAgent` in `packages/ai/src/utils/pi-user-agent.ts`, against upstream User-Agent changes.

## 2026-10-08 - Haiku 5.5 stays off for tool_reference loading until verified (senpi#2892, senpi#2914)

### What changed

- `packages/ai/src/utils/prompt-cache-ttl.ts`: the `defaultSupportsToolReferences` doc comment names Claude Haiku 5.5 as listed in Anthropic's tool-search table but kept off (the existing `haiku` exclusion) until a live probe; no behavior change.

### Why

The same table lists Haiku 4.5, which rejects client-side `tool_reference` blocks (#6474), and a rejection other than `Tool reference '…' not found` would fail the turn with no automatic demotion. senpi#2914 tracks the probe and the enable.

### Why an extension could not handle it

The `supportsToolReferences` default lives in the provider compat matrix.

### Expected merge conflict zones

- The `defaultSupportsToolReferences` doc comment in `prompt-cache-ttl.ts`.

## 2026-10-07 - Structured OAuth refresh retry facts (senpi#2893)

### What changed

- `packages/ai/src/utils/oauth-refresh-error.ts`: shared HTTP error, cycle-safe structured cause classification, closed log-safe cause classes, and cross-bundle unavailable brand.
- `packages/ai/src/utils/retry.ts`: retry a terminal OAuth-unavailable diagnostic before wording classification.

- `retry.ts` now defines `OAUTH_REFRESH_UNAVAILABLE_DIAGNOSTIC` itself, beside the classifier that reads it, so the `./utils/retry` and `./utils/provider-failure-description` entry graphs stay within budget. `oauth-refresh-error.ts` no longer exports it, and its cause walk is bounded at 16 links as well as cycle-safe.
### Why

Opaque transport prose cannot reliably identify transient refresh failures.

### Why an extension could not handle it

Shared retry decisions and cross-package error contracts are core request mechanics.

### Expected merge conflict zones

- `isRetryableAssistantError` and the new shared error module.
