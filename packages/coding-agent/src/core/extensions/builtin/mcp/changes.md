## 2026-10-25 - Parameter-header validation diagnostics (senpi#4246)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/parameter-headers.ts`: return fixed rejection reasons, warn once per rejected tool, traverse unknown keyword objects and arrays while skipping instance-data keywords, and reject present values that do not match annotated primitive types.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/transport.ts`: send rejection warnings to the connection logger and preserve local validation errors without treating them as transport failures.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/dispatch.ts`: pass the existing connection logger into the modern HTTP transport.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/request.ts`: preserve the typed local validation error across the request adapter's diagnostic boundary.

### Why

- SEP-2243 requires properties-only annotation paths and recommends warnings naming rejected tools and their reasons. Silently omitting a present, mistyped argument's header sends a misleading request to the server.
- Regression coverage now asserts a projected header before catalog refresh, so removing parameter projection cannot pass an absence-only assertion.

### Why an extension could not handle it

- The builtin owns catalog filtering, per-connection annotation paths, HTTP header projection, and transport error classification.

### Expected merge conflict zones

- Annotation traversal and value extraction in `modern/parameter-headers.ts`, catalog delivery and local errors in `modern/transport.ts`, transport construction in `modern/dispatch.ts`, and error classification in `modern/request.ts`.

## 2026-10-24 - Validate OAuth discovery issuers before credential use (senpi#4194)

### What changed

- `auth/oauth-issuer.ts` validates metadata against the discovered authorization server, preserving exact PRM identifiers and the SDK's origin fallback for path-served resources without PRM.
- `auth/oauth-provider.ts` validates both cached and new discovery, deletes credentials bound to another issuer before re-registration, stamps newly stored credentials with the validated issuer, and declares native registration for loopback redirects.
- `auth/oauth.ts` checks the issuer of pasted error responses before exposing their contents and persists injected discovery through the same validation boundary.
- `auth/oauth-refresh.ts` checks the client registration's issuer as well as the token's issuer before sending a refresh request.
- Credential stamps use one canonical form that removes only an origin-only URL's final slash. Existing root-fallback sign-ins refresh without registering again, and grants without AS metadata are stamped from the validated discovery issuer.
- Invalid cached metadata is rediscovered rather than requiring logout. A callback without trusted discovery is rejected before exchange, and redirect-less clients omit `application_type`.

### Why

- SDK discovery parsed metadata without comparing its issuer. Direct client-credentials grants and refresh could retain or use registrations belonging to a different issuer.

### Why an extension could not handle it

- Discovery persistence and credential use are owned by the builtin's SDK OAuth provider.

### Expected merge conflict zones

- LOW: discovery persistence in `auth/oauth-provider.ts`, pasted redirect parsing in `auth/oauth.ts`, and grant validation in `auth/oauth-refresh.ts`.

## 2026-10-25 - Listen for modern MCP catalog and resource changes (#4234)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/subscriptions.ts`: own the long-lived listen request, capability-derived filters, acknowledgment subsets, subscription ID correlation, complete paginated resource URI sets, cancellation, and bounded reconnect backoff. Matching response IDs end streams even without subscription metadata. Accepted resource URIs gate delivery; an acknowledged replacement takes over before canceling its predecessor. Missing acknowledgment filters fail with backoff, which resets only after an accepted notification. Each resource sweep owns its URI buffer, with only the latest sweep allowed to publish.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/sdk-bridge.ts`: route HTTP subscription messages separately from finite SDK requests and dispose streams with the bridge.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/stdio-probe.ts`: reestablish subscriptions on each negotiated stdio connection and correlate their notifications alongside ordinary in-flight request IDs.
- `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: modern resource lists supply the listen filter instead of sending the removed resources/subscribe method; legacy subscriptions are unchanged.
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`: keep subscription retry scheduling and cancellation on the shared clock, resolving the current runtime timers so deterministic fake-timer coverage exercises the same lifecycle.

### Why

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/subscriptions.ts`: modern servers cannot push catalog or resource changes without an explicit listen request. Graceful completion must not reconnect, filter replacement must not create a delivery gap, unsupported resource updates must not refresh the catalog, and concurrent listings must not mix or republish stale resource sets.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/sdk-bridge.ts`: a listen stream must not expire with the SDK's ordinary request timeout or block tool calls.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/stdio-probe.ts`: notifications on a shared stdio channel must match an acknowledged subscription ID.
- `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: the modern subscription filter replaces the legacy per-resource RPC.
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`: raw subscription retry timers bypassed the MCP async-source guard.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/subscriptions.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/modern/sdk-bridge.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/stdio-probe.ts`: the builtin transport owns negotiation, wire request IDs, stream lifetime, and disconnect.
- `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: the builtin resource helper chooses the protocol-specific subscription mechanism.
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`: the builtin owns the shared scheduler used by transport lifecycles.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/subscriptions.ts`: subscription state and filter updates.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/sdk-bridge.ts`: message delivery and close hooks.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/stdio-probe.ts`: modern send and receive wrappers.
- `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: resource subscription helper.
- `packages/coding-agent/src/core/extensions/builtin/mcp/wrap.ts`: shared clock scheduling and cancellation.

## 2026-10-25 - Preserve modern MCP tool schemas and JSON results (senpi#4191)

### What changed

- Introduced explicit modern tool/result contracts and era-specific operations over the existing connection and MRTR request owner. Modern lists and calls bypass the SDK's legacy tool helpers.
- Catalogs and persistent caches retain raw input/output schemas and the negotiated era. Modern exposure retains additional properties constraints and reference siblings.
- Draft 2020-12 validates schemas, arguments, and structured output without coercion, network reference fetching, or shared schema identifiers. Schema depth and node counts are bounded.
- Discovery and cache loading reject only tools with invalid or unsupported input/output schemas, warning with the tool name and a fixed reason, never argument values. Cached registration uses the connected client's era, including caches written before the era flag existed; an invalid current schema returns a structured refusal.
- Modern tool operations use static imports and the service uses a top-level tool-contract type import. SDK schemas still load through the existing documented `sdk.lazy.ts` boundary, preserving the startup import budget.
- Legacy cache entries retain the absent modern flag after connection, so unchanged metadata does not invalidate an existing once-only permission approval.
- Legacy SDK helpers and legacy exposure conversion remain unchanged.

### Why

- The SDK's object-root schemas and draft-07 validator rejected valid modern definitions and falsy/non-object structured results before model exposure.
- MCP 2026-07-28 `basic/index.mdx:255-258,291-293` requires 2020-12 and graceful unsupported-dialect errors, not draft-07 support. The explicit draft-07 example is rejected per tool rather than removing the server's valid tools.

### Why an extension could not handle it

- The builtin owns discovery, catalog persistence, request dispatch, and model-tool registration before third-party extensions can repair the rejected results.

### Expected merge conflict zones

- Catalog/cache tool types, exposure registration and invocation validation, and the shared service's wire-tool type alias.

## 2026-10-25 - Fixed processing error for ambiguous legacy origins (#4248)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/elicitation.ts`: reuse the private processing-error helper for ambiguous legacy origins, returning code `-32603`, message `Elicitation processing unavailable`, and no `data`.

### Why

- The approved presenter contract requires ambiguity and presenter unavailability to expose the same body-free error. The previous branch exposed an explanatory message and reason field.
- This supersedes #4210's explanatory-error and `data.reason: "ambiguous_legacy_origin"` descriptions in the private legacy routing entry. No form is displayed or human answer admitted; enforcement-off behavior is unchanged.

### Why an extension could not handle it

- The builtin MCP request handler owns the JSON-RPC error response before any form is displayed.

### Expected merge conflict zones

- LOW: the ambiguous-origin branch in `packages/coding-agent/src/core/extensions/builtin/mcp/elicitation.ts`. Enforcement-off behavior is unchanged.

## 2026-10-25 - Modern HTTP parameter headers (#4229)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/parameter-headers.ts`: validate schema annotations, retain exact property paths per connection, encode primitive values, and omit absent or invalid values.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/transport.ts`: filter invalid tool definitions on JSON and SSE catalog responses and derive parameter headers from the matching call arguments.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/wire.ts`: use standard UTF-8 Base64 with the exact sentinel for unsafe or ambiguous routing names.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/http-fetch.ts`: discard configured parameter headers before merging body-derived metadata.

### Why

- Modern HTTP peers require annotated parameters in routing headers and reject names encoded with the former nonstandard sentinel.
- Configured headers and unrelated arguments must not become tool parameter metadata. Legacy HTTP and stdio behavior remains unchanged.

### Why an extension could not handle it

- The builtin transport owns HTTP headers and must reject invalid catalog definitions before the SDK exposes them.

### Expected merge conflict zones

- Request header derivation and catalog delivery in `modern/transport.ts`, configured-header merging in `modern/http-fetch.ts`, and routing-name encoding in `modern/wire.ts`.

## 2026-10-25 - Private legacy and modern MCP form routing (#4197)

### What changed

- `elicitation.ts`: route enforced legacy requests through private validation and settlement, with body-free processing failures when no presenter is available.
- `elicitation.ts` and `request-origin.ts`: explicitly report `-32603` with `data.reason: "ambiguous_legacy_origin"` when concurrent legacy tools/call requests have no safely attributable parent; recommend sequential calls or MRTR without displaying or admitting a form.
- `modern/request.ts` and `request-origin.ts`: retain exact operation origins, recheck private presenter readiness at attempts, and distinguish operation termination from presenter cancellation.
- `modern/consent-queue.ts`: share the existing abort-aware FIFO with the opt-in local authority while preserving the default MRTR queue.
- `modern/form-schema.ts` and `modern/elicitation.ts`: share whole-form validation and actual-presentation acknowledgement with RPC and local presenters.
- `service.ts`, `shared-connection.ts`, and `host-registry.ts`: propagate live readiness subscriptions and private origins. Enforced shared pools observe any ready owner instead of freezing eligibility in their creation-time key; per-operation authority still selects the presenter.
- `service.ts`: capture the declaring session's binding and UI references while its extension context is live. Readiness checks keep observing the binding's presenter without dereferencing a stale context after release or degrading the connection still used by a peer.
- `connection.ts` and `modern/client.ts`: record the negotiated legacy capability and reconnect when a grant or revocation makes it stale, rechecking readiness before publishing an initialization. Modern MRTR connections keep per-attempt capabilities without reconnecting.
- `modern/request.ts`: leave the SDK request method untouched for default legacy clients, preserving their origin and concurrent-call behavior.
- `transport-sdk.ts`: retain private stderr diagnostic records and allowlisted system error codes while redacting arbitrary server text that may echo forms; preserve ordinary legacy stderr.

### Why

- A session's ordinary UI provider cannot authenticate a human or safely select an owner for an unsolicited legacy form.
- A shared connection can outlive its original declarer. Re-reading that released session's `ctx.ui` during an ordinary connect check threw `StaleExtensionContextError` and made the peer's tools unavailable despite unchanged legacy-form eligibility.

### Key decisions

- Modern capability metadata remains request-scoped. Legacy capability advertisement is fixed within each connection and renegotiated when live readiness changes; every elicitation still checks its origin and presenter.
- The SDK's received legacy handler metadata has no reliable parent tool-call ID. Ambiguous concurrent legacy operations fail with a clear coded processing error under enforcement; they are not assigned to a guessed owner.
- A no-human request is a processing failure, explicit refusal is decline, and dismissal after actual presentation is cancel.
- Private schemas and submitted content are validated before the terminal latch; rejected submissions never admit human input.

### Why an extension could not handle it

- The MCP service owns transport initialization, request origins, shared leases, and continuation dispatch.

### Expected merge conflict zones

- MEDIUM: the stacked MRTR request executor and shared elicitation validator.
- LOW: service connection creation and stderr classification.

## 2026-10-25 - Private terminal consent for modern MCP continuations (#4207)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/request.ts`: interpret intermediate results before method-result validation, replace continuation state, issue fresh request IDs, and bound rounds, bytes, consent, and operation lifetime.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/client.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/modern/consent-queue.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/inputs.ts`: separate negotiated client construction, binding-owned consent scheduling, and bounded batch parsing from operation execution.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/elicitation.ts`: collect flat primitive forms with explicit defaults, unset choices, review, editing, submission, and cancellation.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/form-schema.ts`: keep schema validation and typed value checks separate from private consent collection.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/consent-queue.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/errors.ts`: reject unpresented aborted jobs with a local processing error and retain numeric remote error codes without server messages.
- `packages/coding-agent/src/core/extensions/builtin/mcp/request-origin.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/prompts.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: carry host-issued session and authority ownership through tool, prompt, resource, and shared-client paths.
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/health.ts`: terminate pending consent on observed lifecycle invalidation and prevent automatic replay of logical MRTR errors.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-sdk.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/dispatch.ts`: activate the adapter only after positive modern negotiation while preserving the legacy SDK request method and legacy stderr diagnostics.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/transport.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/modern/http-fetch.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/modern/wire.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/diagnostics.ts`: cancel by request ID, fence dispatch, suppress raw modern diagnostics, and avoid authenticated continuation replay.

### Why

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/request.ts`: an intermediate `input_required` result is not a completed tool, resource, or prompt result and must not reach the model.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/elicitation.ts`: form acceptance requires the originating terminal human; unpresented requests terminate, explicit refusal declines, and presented dismissal cancels.
- `packages/coding-agent/src/core/extensions/builtin/mcp/request-origin.ts`: a pooled physical connection must not lend one session another session's human capability, consent, credentials, or continuation state.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-sdk.ts`: modern diagnostic privacy must not discard legacy startup and reconnect diagnostics.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/request.ts`: ordinary extensions receive SDK-validated method results after the point where intermediate control results must be intercepted.
- `packages/coding-agent/src/core/extensions/builtin/mcp/request-origin.ts`: only the host can issue nonserializable session ownership and recheck the existing observed authority boundary.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-sdk.ts`: transport dispatch, request cancellation, protocol negotiation, and raw diagnostic delivery precede extension callbacks.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-sdk.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/modern/dispatch.ts`: reconcile independent legacy/headless capability changes without restoring a connection-global modern human capability.
- `packages/coding-agent/src/core/extensions/builtin/mcp/modern/request.ts`: method-result interception, operation budgets, and dispatch authority checks.
- `packages/coding-agent/src/core/extensions/builtin/mcp/request-origin.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/prompts.ts`, and `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: request-local origin propagation.

## 2026-10-24 - Error on unavailable elicitation and omit print/json capability (senpi#4185, PR #4196)

### What changed

- `index.ts` binds an elicitation UI only when the session context has human UI.
- Connection options carry the declaring mode's elicitation support through reconnect and transport materialization. Legacy initialization, modern HTTP discovery/requests, and modern stdio metadata use the same capability selection.
- Clients without elicitation support reject unsolicited requests with the SDK's `McpError` processing error through its public fallback handler, which does not require advertising a capability. The shared pool's single in-flight lessee routing is unchanged; an unavailable or ambiguous owner UI reaches the same error path.
- Boolean collection uses `select` instead of `confirm`: the latter collapses cancellation into `false` in RPC, while the existing selection protocol preserves it as `undefined`. This also covers automated clients that do not declare a connection role.
- An undefined input cancels even for an optional field; an empty answer may still skip that field. Empty submissions require an explicit Submit selection.

No human at request time -> processing error (`-32603`, fixed message, no form content); dismissed or automatically cancelled dialog -> cancel with no content; decline only from an explicit Decline control, which this PR does not add (tracked in #4188/#4189). Distinguishing automated cancellation from human dismissal requires a cancellation-origin contract, tracked in #4197. Explicit Yes/No choices retain their boolean meaning.

### Why

The extension runner's no-op UI returns `false` for confirmation. Treating that object as human UI accepted boolean-only forms without a human response.
RPC confirmation also maps cancellation to `false`, so changing an automated client's reply alone cannot distinguish cancellation from a human's explicit No.

### Why an extension could not handle it

The builtin owns capability advertisement, transport construction, and the UI provider used by server requests.

### Expected merge conflict zones

- Elicitation UI binding in `index.ts`, connection option propagation, and capability construction in `transport-sdk.ts` and `modern/dispatch.ts`.

## 2026-10-24 - Unreferenced servers keep their identity; catalog caches are read before generations (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-generation.ts`: `resolveWantedMcpGenerations` keeps the declared `configHash` as the generation identity of a server that declares no reference, instead of re-hashing its snapshot under the resolving session's agent dir.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `#syncFromConfig` reads the catalog caches before it resolves the generations, so the cache read stays the sync's first await.

### Why

- A credential re-sync while a session was between release and re-attach resolved that session's unreferenced server under the peer's agent dir. The new hash re-keyed the server, which was stopped and re-spawned, and the re-spawned process outlived the test worker.
- Resolving the generations before the cache read let a release land first, so the attach of a session that quit never reached its cache read.

### Why an extension could not handle it

- Connection identity and the sync order are internal to the builtin MCP service.

### Expected merge conflict zones

- LOW: `resolveWantedMcpGenerations` in `config-generation.ts` and the cache-read block of `#syncFromConfig` in `service.ts`.

## 2026-10-24 - Project skill servers refuse reference objects under the env policy (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: a project-provenance skill server that declares a reference object is skipped with the existing named refusal before the project environment policy runs.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-references.ts`: `plainMcpDeclaration` and `plainMcpServerConfig` refuse the first reference and narrow a declaration to plain strings; `project-env.ts` and `project-skill-policy.ts` take only that narrowed form.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts`: the project authority is looked up on the declared config, because the connection generation is a new snapshot object.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-spec.ts`: the stdio spec carries the project policy's `projectPolicy` and `resolveBeforeStart`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: a connection's key, catalog-cache identity and shared pool key combine the declaration hash (which carries a project server's policy identity) with the resolved generation hash, so an env-only edit of a project skill server re-keys and reconnects. A reference that appears in the skill file between the refusal check and the policy's re-read is reported as the same named skip.

### Why

- The project environment policy (senpi#3796) expands only `${VAR}` strings and its materialized config spawns the child, so a reference object would reach the spawn unresolved or read ambient values outside the grants. Failing closed keeps the grant policy whole; resolving references inside the policy is a follow-up.

### Why an extension could not handle it

- The policy and the MCP service are the builtin MCP extension itself.

### Expected merge conflict zones

- `attachSkillMcpServers` in `service.ts`, `createMcpSessionConnection`, and the stdio spec builder.

## 2026-10-23 - Close reference output and startup diagnostic gaps (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/guard/output-guard.ts`: sanitizes a separate content projection before returning inline text or writing spill files. Model-facing results are sanitized by default: provider requests leave the process, so a server echo must not forward a resolved credential to the provider. No documented pass-through contract was found; the MCP documentation already promises tool-output redaction. Wire replies and resource identifiers remain raw in memory.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/call.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/expose/register.ts`: sanitize progress notifications, result details and user-facing tool errors, including structured results mapped to text.
- `packages/coding-agent/src/core/extensions/builtin/mcp/resources.ts`: sanitizes resource listings, read previews, error messages and expanded mentions without changing the URI sent to the server.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-generation.ts`: logs each typed reference failure and clears obsolete failures on the next sync; failed servers still open no transport and do not prevent sibling connections.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`: expose failed reference resolution as `degraded` with the sanitized named `lastError` in status and RPC inventory. The `needs_auth` snapshot override also redacts its error before status and RPC projection, without modifying the connection's original error.

### Why

- Real CLI QA found resolved values in RPC tool results despite redacted logs, and missing-reference servers silently remained `enabled` in RPC inventory. The existing failure map preserved containment but was not projected to all user-facing surfaces.

### Why an extension could not handle it

- Tool-result projection, spill persistence and pre-transport failure capture belong to the MCP builtin. A downstream extension cannot reliably intercept every sink.

### Expected merge conflict zones

- LOW: content projection in `packages/coding-agent/src/core/extensions/builtin/mcp/guard/output-guard.ts`, `expose/call.ts`, `expose/register.ts` and `resources.ts`.
- MEDIUM: `#serverSnapshot` and `#captureWireStatusServer` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`; failure capture in `config-generation.ts`.
- LOW: optional `lastError` on `McpWireStatusServer` in `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`.

## 2026-10-22 - Key MCP identities with a per-installation secret and adopt legacy caches by credential (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-identity-key.ts`: the installation key `config-identity.key` in the agent directory is 32 random bytes written to a private temporary file and published with `link()`, so it is complete or absent and never replaced. An existing key is used only as a regular file owned by the user, mode `0600`, exactly 32 bytes. Without a valid key, identities are `ephemeral:` HMACs under a per-process key. An invalid file produces one warning per path naming the problem and repair, explaining that persistent catalog caching is disabled and a restart is required after repair; the file stays untouched and key bytes are never logged.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-identity.ts` and `auth/catalog-identity.ts`: `hashConfig` and the catalog credential identity are HMAC-SHA-256 under that key; the unkeyed forms remain only to read entries earlier builds wrote.
- `packages/coding-agent/src/core/extensions/builtin/mcp/log.ts`: literal-header and log redaction fingerprints are keyed too.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`: an `ephemeral:` identity is never persisted.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache-adoption.ts` and `service.ts`: a cache entry written under the unkeyed identities is adopted, and rewritten under the keyed ones, only when both its config hash and its credential identity match, so offline lazy catalogs keep working and a changed account never inherits another's catalog.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` and `config-generation.ts`: identities are keyed with the session's agent directory.

### Why

- A plain SHA-256 of a config or a bearer token is an offline-guessable fingerprint of the secret it covers, and it is persisted in the catalog cache and exposed in status.

### Why an extension could not handle it

- Catalog identity, cache persistence and connection admission are private to the MCP builtin.

### Expected merge conflict zones

- MEDIUM: the cache lookup in `#syncFromConfig` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`.
- LOW: `hashConfig` in `packages/coding-agent/src/core/extensions/builtin/mcp/config-identity.ts` and `mcpCredentialIdentity` in `auth/catalog-identity.ts`.

## 2026-10-22 - Sanitize MCP sinks through the resolved-reference registry (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/log.ts`: every log line, in the ring buffer and the log file, is scrubbed of registered values after the existing pattern redaction.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`: the catalog cache persists a redacted copy; the in-memory catalog, whose resource URIs are sent back on subscribe, keeps the server's exact strings.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-snapshot.ts`, `diagnose.ts` and `service.ts`: server snapshots, connect diagnostics and the RPC wire status carry redacted text; the original errors are unchanged.
- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`: `/mcp` error notifications are redacted.

### Why

- These are the MCP outputs that leave the process or are persisted for display; a reflected value must not reach any of them.

### Why an extension could not handle it

- The MCP logger, catalog cache, status snapshots and commands are private to the builtin.

### Expected merge conflict zones

- LOW: `#formatLine` in `packages/coding-agent/src/core/extensions/builtin/mcp/log.ts`.
- LOW: `writeMcpCachedServer` in `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`.
- LOW: `#captureWireStatus` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`.

## 2026-10-22 - Admit MCP references by source and resolve them per connection generation (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`: `headers.*`, `env.*` and `args[]` accept exact `$file`, `$env` and `$concat` objects; `url`, `command`, `cwd` and OAuth fields keep refusing them. `McpServerDeclaredConfig` is the declared server; `McpServerConfig` stays the resolved snapshot every connection, transport and diagnostic uses.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-references.ts`: lists a server's reference positions, records the declaring file as each reference's trusted origin when a trusted file is read, and refuses references from sources that do not expand legacy `${NAME}`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`, `config-extension.ts` and `skill-server.ts`: trusted global, project and Claude files and trusted stdio skills record origins; extension declarations, remote skills and untrusted skills are refused before any I/O, each as its own diagnostic or warning.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-generation.ts`: resolves one connection generation into an immutable snapshot, keys it, and for a declaring server re-reads every transport's references, re-keying when the snapshot changed. A server whose reference fails is reported and never connects; the others continue.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`, `service-connection.ts`, `service-snapshot.ts`, `service-types.ts`, `startup-race.ts` and `service-tools-changed.ts`: connection keys, shared-connection identity and catalog identity follow the admitted generation; `reconnectServer` re-reads first and re-keys a changed snapshot; a reference failure is the server's `lastError`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`, `connection-types.ts`, `transport.ts` and `shared-connection.ts`: every transport of a declaring server builds its spec from a fresh snapshot; a shared renewal whose snapshot changed re-keys every lease.
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/context.ts`, `auth/catalog-identity.ts`, `auth/commands-auth.ts`, `catalog.ts`, `catalog-cache.ts`, `config-identity.ts`, `config-normalize.ts`, `expose/policy.ts`, `expose/status.ts`, `manager.ts` and `sharing-policy.ts`: accept the declared type where they read only non-reference fields; literal-secret and session-value scans skip reference objects.

### Why

- A secret file or variable referenced from `mcp.json` must be read where legacy `${NAME}` would be expanded and nowhere else, on every connection generation so a rotated file is picked up, and one broken reference must not take down the other servers.

### Why an extension could not handle it

- MCP config loading, trust, connection admission and transport construction are private to the builtin.

### Expected merge conflict zones

- MEDIUM: `#syncFromConfig` and `reconnectServer` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`.
- MEDIUM: `createMcpSessionConnection` in `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts`.
- LOW: the server schema and types in `packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts`.
- LOW: `materialize` in `packages/coding-agent/src/core/extensions/builtin/mcp/transport.ts`.

## 2026-10-22 - Extract extension server resolution and transport spec building without behavior changes (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-extension.ts`: holds the unchanged `resolveExtensionMcpServer` and `mergeExtensionMcpServers`, moved from `config.ts`, which re-exports them.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-spec.ts`: holds the unchanged stdio and HTTP spec builders, bearer header assembly and `errorMessage`, moved from `transport.ts`; `mcpTransportSpec` selects the builder by transport type exactly as `createMcpTransport` did.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/transport.ts`: import the moved units.

### Why

- Isolates extension admission and transport spec building, which reference support changes, so those edits land in focused modules within the size boundary.

### Why an extension could not handle it

- MCP config loading and transport construction are private to the builtin.

### Expected merge conflict zones

- LOW: the re-export block in `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`.
- LOW: `createMcpTransport` and the import block in `packages/coding-agent/src/core/extensions/builtin/mcp/transport.ts`.

## 2026-10-21 - Keep typed references opaque during legacy interpolation (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-interpolation.ts`: the legacy walker returns an entire valid reference object unchanged, preserving concat literals and file paths. Environment values retain existing nullish/fallback semantics and receive the shared name-only warnings.

### Why

- Walking inside a reference before its use-time resolution would alter its path and interpret literal concat text.

### Why an extension could not handle it

- Core configuration loading runs this walker before extension merging.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/builtin/mcp/config-interpolation.ts`.

## 2026-10-21 - Extract MCP config helpers without behavior changes (senpi#3858)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/config-error.ts`: the existing validation error moved to its own module.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-identity.ts`: the existing hash implementation moved unchanged to its own module.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-interpolation.ts`: the existing legacy interpolation walker moved unchanged to its own module.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-normalize.ts`: server defaults moved unchanged to their own module.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`: imports and re-exports these helpers so existing callers keep the same API.

### Why

- Isolates the interpolation walker and the configuration identity that reference support changes, so those edits land in focused modules.

### Why an extension could not handle it

- Core configuration loading runs these helpers before extension merging.

### Expected merge conflict zones

- MEDIUM: helper imports and exports in `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`.
- LOW: the four extracted modules.

## 2026-10-18 - Skip MCP attach during size inspection (senpi#3483)

### What changed

- `index.ts`: `session_start.sizesOnly` returns before starting either HTTP or stdio attachment. Normal startup and preview composition retain their existing attach promise.

### Why

Size inspection must not connect to configured MCP servers. The report inventories configured names/count without sizes and explicitly excludes their tools. A real HTTP recording fixture asserts zero connections for diagnostic startup and successful attachment for normal startup.

### Why an extension could not handle it

The built-in starts the attach; another extension cannot undo its network work.

### Expected merge conflict zones

- `index.ts`: `session_start` immediately before `onSessionStart`.

## 2026-10-20 - Retain same-session skill servers during MCP administrative reattach (senpi#3796)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` retains skill-resolved servers when the same live session reattaches with the same agent directory, explicit environment and trust decision. Newly loaded system or extension declarations still win name collisions. The effective trust decision is captured in the binding's options.

### Why

The reconnect command reattaches after renewing its server. Rebuilding config without the session's skill declarations disposed every skill transport, including a peer project's pending policy resolution, which then reported that its materialization was invalidated. Skill registrations last for their declaring session; an administrative reattach is not an unload.

### Why an extension could not handle it

`packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` owns the session binding and config reconciliation that dispose unwanted connections. Grant observers and generation invalidation remain authoritative, and changed session identity, trust, environment or agent directory do not inherit these registrations.

### Expected merge conflict zones

Session option capture and config reconciliation in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`, especially the load/merge/bind sequence in `attachSession`.

## 2026-10-20 - Scope project skill MCP environment grants to declarations (senpi#3796)

### What changed

Project skill servers use a finite inherited environment, explicit session overrides and declared values, with selective expansion after a names-only grant decision. User skill servers retain their existing resolver. `skills.ts` reauthorizes cached sidecars and frontmatter with provenance plus the allowed-set digest. `index.ts` feeds blocked declarations into retained session notices.

The self-contained `env-grants-store.ts` supplies the shared version-1 schema, canonical declaration digest, atomic locked writer and state-reconciliation observer. Native callers pass the configured agent directory to its exported path resolver. `project-skill-policy.ts` rechecks declaration identity before grant writes and every transport materialization.

`packages/coding-agent/src/core/extensions/builtin/mcp/env-grants-store.ts` retries only Windows `EPERM`, `EACCES` and `EBUSY` atomic replacements while holding the existing lock, with five backoffs totaling 1,550 ms.

The store stays self-contained (no senpi-internal imports; oh-my-openagent vendors it byte-for-byte), so it does not use `core/file-lock.ts`. Instead its proper-lockfile lock passes its own `onCompromised`, which never throws (the default throws from a heartbeat timer and crashes the process) and only records the loss. Before every rename attempt, including each Windows retry, a lost lock refuses the write with `GrantsLockLostError` (code `ELOCKLOST`), leaving the old file and no temporary file. A lost lock is not released, so the new owner's lock is never removed. `test/proper-lockfile-reference-guard.test.ts` allow-lists this one vendored file and checks that it has no relative imports and an `onCompromised` on every lock call. `test/file-lock-lost-writes.test.ts` and `3796-grants-store.test.ts` (a loss during a Windows backoff) cover the refusal.

`connection-types.ts`, `connection.ts`, `service-connection.ts`, `service.ts`, `transport.ts`, `transport-sdk.ts` and `project-stdio-transport.ts` carry policy through initial connect, renew and SDK restart. Project-only pool keys in `sharing-policy.ts` include declaration, policy and provenance digests. `host-registry.ts` observes grants and invalidates all matching underlying connections through `shared-connection.ts`, without waiting for leases to become idle.

### Why

Project declarations must not inherit unrelated ambient secrets or reuse another declaration's grant. Revocation must close an already shared child and prevent stale in-flight materialization.

Concurrent readers, watcher reconciliation and antivirus can briefly hold the destination open on Windows, denying an otherwise valid atomic rename.

### Why an extension could not handle it

This builtin owns declaration resolution, transport construction, the shared connection pool and reconnect lifecycle.

### Expected merge conflict zones

Skill declaration cache keys, service attachment, transport materialization, shared pool identity and connection generation transitions.

## 2026-10-14 - Negotiate modern MCP behind an SDK lifecycle bridge (senpi#3304)

### What changed

- HTTP connections discover the protocol era before constructing the selected transport. Modern HTTP uses stateless POST requests; legacy connections retain the existing SDK materializer and wire behavior after discovery.
- `modern/sdk-bridge.ts` answers the SDK's `initialize` locally from validated discovery and consumes `notifications/initialized` locally. Connection diagnostics distinguish the real negotiated wire version from the SDK compatibility version.
- `modern/era.ts` uses the shared request builder, headers and strict code-only classifier in `wire.ts`. Era tests now use -32020 (HeaderMismatch), -32021 (MissingRequiredClientCapabilityError), and -32022 (UnsupportedProtocolVersionError). Named -32000-class forms in the compatibility prose do not establish the modern era; generic error text cannot safely select a different protocol.
- Stdio probes discovery on the actual spawned transport before initialization and retains that same process for legacy fallback. A modern stdio child keeps that same process: `stdio-probe.ts` answers the SDK's `initialize` locally from discovery (the HTTP bridge's `modernInitializeResult`), drops `notifications/initialized`, and rewrites every later request and notification with the per-request `_meta` at the negotiated version (`wire.ts` `modernizeRequest`, shared with the HTTP transport). A modern stdio child whose discovery answers only with a modern error fails the connect with that error and is closed, never restarted or sent a legacy `initialize`; a -32022 rejection gets one retry at the newest mutual version, as on HTTP.
- The stdio probe never breaks a legacy server that connects today. It waits at most `STDIO_PROBE_MS` (2 s, capped at a quarter of the connect timeout) under a string id (`senpi-era-probe`) the SDK, which numbers its requests from 0, can never produce. A clean non-modern JSON-RPC error reply, or no reply in time (a slow start, or a server that ignores unknown requests), keeps the SAME process for the legacy handshake; nothing is killed for being slow. Until the SDK's `initialize` gets its reply the probe window stays open: if that silent child then exits or writes non-JSON (a slow `uvx`/`npx` start of an older Python server that dies on the unknown request), it is restarted and the recorded `initialize` is replayed on the fresh process. If its discovery reply arrives late and complete and it then rejects `initialize` with any error, the rejection is replaced by the local initialize answer and the stream switches to modern (a legacy server cannot produce a complete discovery, so any error is safe to upgrade on); a slow-starting modern server thus connects on its first process, with one rejected legacy `initialize` on its wire. If instead `initialize` succeeds, the connection stays legacy for its lifetime even when a late discovery reply arrived. The upgrade relies on the server answering in order, as stdio servers do. A slow server that prints a non-JSON banner to stdout before answering `initialize` is therefore restarted once (startup paid twice), the same rule that applies inside the probe window; it still connects. Requests the SDK sends while a child is being replaced wait for the fresh process, so `initialize` reaches it exactly once. Once `initialize` is answered the probe wrappers are removed. Late probe replies never reach the SDK. Only a child that exited (as older Python SDK servers do on an unknown request) or wrote non-JSON to stdout is reaped and replaced by a fresh process for the untouched legacy handshake; the old child's close event is swallowed once, and a dispose that races the respawn closes the new child. A server that crashes on start is therefore spawned twice (probe, then legacy) and never more; `test/mcp/connection.test.ts`'s spawn count reflects that. Once a server has answered -32022 it is never downgraded: an unclean retry fails the connect as modern.
- On HTTP, a well-formed JSON-RPC error without a modern code means legacy at any status (some servers answer an unknown method with 200), and an authorization failure during the probe propagates as needs-auth instead of being read as a transport error, so the OAuth flow is not started a second time by the legacy transport.
- The two strict per-directory tsconfigs left from the implementation waves are removed; the root typecheck covers `modern/`.
- No era cache: each connection probes once at materialization, and a cache scoped to one connection could never be reused. Caching across reconnects would need a service-scoped owner keyed by endpoint and credentials, and is left for when it is measured to matter.
- `connection.ts` owns a pending connection before discovery and handles materialization errors through its existing connect-failure path. Disposing a pending connection aborts discovery. Each connection owns its era cache, so endpoint metadata and credentials cannot leak across sessions. Legacy session-required 404 responses still use the original SDK initialization and diagnostics.

### Why

Contract (a), a transport-level SDK compatibility adapter, preserves the installed SDK's actual invariants without copying its client implementation or mutating private state. SDK 1.32.1 installs protocol callbacks, requests `initialize`, validates `InitializeResultSchema` and its supported-version list, populates capabilities/serverInfo/instructions, calls `setProtocolVersion`, sends `notifications/initialized`, and installs capability-dependent list handlers. The bridge supplies discovery's capabilities, namespaced serverInfo and instructions through that normal validation path, using the SDK's own latest version solely for its local schema dialect; discovery must independently support the real modern wire version. That local version never reaches the modern transport or server. A facade would duplicate catalog, elicitation and notification behavior; post-connect seeding would couple us to private fields and skip initialization side effects. Once the SDK supports modern discovery natively, delete the bridge and the factory dispatch rather than replacing downstream Client consumers.

### Why an extension could not handle it

The MCP builtin owns transport construction and SDK initialization; another extension cannot replace this private lifecycle seam.

### Expected merge conflict zones

`transport.ts`'s materialization seam, `connection.ts`'s pending connection ownership, and the `modern/` modules. The legacy SDK materializer remains unchanged.

Fixture accounting decision: `test/mcp/fixtures/sharing-http.ts` now increments `connects` only in the SDK's one-time `onsessioninitialized` callback, rather than for every sessionless POST. The existing sharing, reconnect, lifecycle, and catalog assertions measure established MCP sessions, not raw HTTP requests; none require raw POST accounting. Counting initialization events therefore preserves every assertion's intent without changing any assertion, remains independent of session-map cleanup during graceful shutdown, and avoids a discovery-specific exception that would still count other rejected sessionless requests as connections. Legacy containment is behavioral: the discovery probe does not establish a session or alter subsequent legacy traffic.

## 2026-10-12 - Retire Codex app-server compatibility (senpi#3167)

### What changed

Capture session wire inventory for Native RPC only after removing app-server mode. Preserve the session-scoped inventory and credential ownership logic.

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`

### Why

The executable Codex compatibility layer is being removed. Shared Native runtime behavior and historical records must remain independent of that layer.

### Why an extension could not handle it

These host contracts, import paths and build or verification targets belong to the repository; an extension cannot retire them.

### Expected merge conflict zones

The listed paths, especially command dispatch, mode unions and process identity imports. Keep the supported runtime branches and the shared utility behavior.

## 2026-10-10 - Unsubscribe the control-inventory listeners on a reload, not only on quit

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`: the shared-service (`sessionOwned === false`) `session_shutdown` handler now runs `disposeControlInventory()` for every reason, including `reload`. It used to skip it on a reload.

### Why

- The reload builds a new runner, and the new factory subscribes `onWireStatusChanged` and the control-inventory request again. The old subscription stayed in the process-wide service's `#wireStatusListeners`, and its closure holds the old `pi`, so the old `ExtensionRunner` and everything it reaches stayed alive: one extension generation per reload. A heap snapshot after 20 reloads showed all 20 old runners reachable from the service's listener set; with every other builtin enabled and `mcp` disabled none were.
- Every config-reload (any watched settings or `omo.jsonc` edit) reloads every live session, so a long-lived RPC worker grew by tens of MB per reload. Workers that went through a reload loop held 15GB.

### Why an extension could not handle it

- The leak is the MCP builtin's own subscription lifetime; nothing outside it can unsubscribe its listeners.

### Expected merge conflict zones

- The `session_shutdown` handler in `createMcpExtension` in `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`.

## 2026-10-08 - Resolve and spawn each session's MCP servers with its own trust, env and agent dir (senpi#2986)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: each session binding now keeps the `McpSessionOptions` it attached with (trust, env, agent dir) beside its config, and the process-wide `#sessionOptions`, `#authAgentDir` and `#authEnv` are gone. `attachSkillMcpServers` resolves a skill's `${VAR}` values with the declaring session's own trust (`options.projectTrusted`, else its context's) and env.
- `service.ts`: `#syncFromConfig` spawns each server with the options and cwd of a session that declares it with the same config hash. The attaching session is used when it declares the server; otherwise the live binding the effective config took the server from. The catalog cache for a server is read from that session's agent dir.
- `service.ts`, `service-types.ts` and `service-connection.ts`: a connection entry records the env it spawned with, next to its agent dir. `getAuthTarget` (re-auth), `getServerAuthStatus` and the wire and lifecycle auth status resolve credentials with the connection's own agent dir and env. They fall back to a live declaring session's options when the server has no connection.
- `service.ts`: a session is offered a connection only when its own config declares the server with the connection's config hash and its own agent dir and env resolve the credential identity (`mcpCredentialIdentity`) the connection spawned with. `#registerDirectTools` and the `#handleServerToolsChanged` refresh targets share this check (`offersConnection`), so republishes, credential-change resyncs and list_changed tombstones follow it too. A session whose credentials differ gets none of that server's tools, and its earlier offers are refused once the connection is replaced. An undefined identity (no bearer token, no stored OAuth tokens) matches only another undefined one, as the connection key's `?? "unknown"` does, so a connection holding no credentials stays shared.

### Why

- Every attach overwrote one process-wide options record, and skill-server expansion, connection spawns and auth all read it. A trusted session attaching after an untrusted one therefore expanded the untrusted project's skill servers as trusted, with the trusted session's environment. Spawns and re-auth likewise used the last attach's credentials for servers that session never declared.
- Connections are one per server name, and offers compared only the config hash. Two sessions declaring the same server with the same config but different agent dirs or envs therefore shared the connection, so one session's calls ran with the other's bearer token or OAuth login.

### Why an extension could not handle it

- The options record, the per-session bindings and the connection spawn path are private state of the MCP builtin's shared service; no extension can see or replace them.

### Expected merge conflict zones

- `McpSessionBinding`, `attachSession`, `#bind`, `attachSkillMcpServers`, `#syncFromConfig`, `#serverSnapshot`, `#handleServerToolsChanged`, `#registerDirectTools`, `getAuthTarget`, `getServerAuthStatus`, `wireAuthStatus` and `offersConnection` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`; `McpConnectionEntry` in `service-types.ts`; the entry literal in `createMcpSessionConnection` in `service-connection.ts`.

## 2026-10-08 - Fence each session's MCP tools with its own config, not the last attach's (senpi#2597)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: each session binding now records the `ResolvedMcpConfig` it attached with. `#registerDirectTools` registers a session's tools from that config and only for the connections `offersConnection` offers it: same `configHash`, and its own agent dir and env resolve the connection's credential identity. The invocation fence no longer compares the process-wide `#config` identity. A session's offers stay current while its own binding and the connection entry they were made against are current. A new attach by the same session replaces its binding and retires its old offers; a peer's attach does not.
- `service.ts`: the shared connections follow an effective config. That config is the attaching session's config plus every server another live binding declares that it does not. A peer whose config lacks a server, such as an OmO memory sidecar loaded without extension-registered servers, no longer tears down a connection a live session still declares. On a name collision the attaching config wins, as before, because connections are one per server name. A credential change (`onCredentialsChanged`, which OAuth token refresh relies on) no longer checks the config's object identity. When its connection is still current, it re-syncs the current config through the counted attach queue that a release re-sync also uses, with the most recent live binding's options. With no live session, it uses the options of the owner of the sync that created the connection. This supersedes the identical-config preservation bullet in the senpi#2843 entry.
- `service.ts`: skill-declared servers (`attachSkillMcpServers`) merge into the declaring session's own config, then into the effective config. That sync runs on the attach queue and counts as a pending sync, like a release re-sync. It runs only if the declaring session's binding is still live when its turn comes. Attaches, release re-syncs, credential re-syncs and skill attaches share one queue-and-count helper, `#queueSync`. A list_changed refresh re-registers and tombstones only in sessions that declare that server with the refreshed connection's hash.
- `service.ts`: `releaseSession` now re-syncs the connections when a session is gone (a dispose reason: quit, or the builtin removed) and live sessions remain. A release with no reason (reload, new, resume, fork) does not re-sync: that session attaches again next, and its attach drops what no live session declares without restarting the servers it still declares. The effective config of the most recent live binding is used, with that binding's options, so a server only the released session declared is stopped instead of keeping its process and credentials alive. The resync runs on the attach queue so it never interleaves with an attach's sync. The release awaits it only when no sync of any kind (attach, skill attach, re-sync, credential re-sync) is pending, so a hung attach still cannot hold a quit. When a connection entry is added, removed or re-created, every live session re-registers its tools, and the most recent live session's wire status refreshes. When no live session remains, the existing dispose and deferred-dispose path is unchanged.
- `service.ts`: a session's MCP status (`refreshWireStatusSnapshot`, which serves the control inventory and the app-server wire status) is built from that session's own config, not the merged one. `#statusOwner` finds the live binding whose context's `sessionManager.getSessionId()` matches the session id, or the most recently attached live binding when no id is given. An attach that binds no session reports its own config. The status lists only the servers that config declares. A server's connection, catalog, server info and connection-derived login status count only when the session declares the server with the connection's config hash and its own agent dir and env resolve the credentials the connection's own options resolve now (`resolvesSameCredentials`). A connection whose tokens went stale therefore still shows as needing auth in its own session, while a peer's connection with other credentials never shows. Otherwise the session's own agent dir and env decide its login status. The merged config still decides which connections live. `releaseSession` deletes the released session's snapshot from `#wireStatusBySession` unless a live binding still reports under that session id. Each binding records its session id at attach (`McpSessionBinding.sessionId`), because a released session's context may already be stale and throw on read.
- `service.ts`: a release re-sync counts as a pending sync, as an attach does (`#pendingAttaches` is now `#pendingSyncs`). A release that leaves no live session while a re-sync is queued or running defers its dispose until the re-sync settles, as it does for a pending attach. `#syncFromConfig` re-checks `#disposed` after each await and creates no connection once the service is disposed. The re-sync stops republishing tools and status once the service is disposed.
- Correction to the senpi#2514 entry's review follow-up: a session that quits while its own attach is still queued now starts nothing when that attach runs. It is not bound, resolves no config, sets no session context and leaves the shared config and its live peers' connections untouched. When it was the only session, the deferred dispose still disposes the service once the attach settles.
- `service.ts`: `releaseSession` re-syncs on a dispose reason even when this call finds no binding because an earlier release with no reason already dropped it. A reload into a runtime without the MCP builtin fires `session_shutdown` (a release with no reason) and then `session_extensions_removed` (a release with `reload`), so the second release now stops the servers only that session declared. It hands `#sessionContext` to the most recent live binding only when it released the binding that held it.
- `service.ts`: `#syncFromConfig` never keeps a connection whose credentials went stale (`credentialsCurrent()` is false), even when its recomputed key is unchanged. It re-creates the connection with the options of the session that declares it now, so the most recent live declarer's credentials win, as they do at attach. `#resyncToLiveSessions` decides whether to republish by comparing the connection entries before and after the sync, not their keys, because a re-created connection keeps its key and the offers made against the old entry stay retired until the tools are republished.
- `service.ts`: a credential re-sync (`#resyncToLiveSessions` called with a fallback owner, from `onCredentialsChanged`) syncs the current `#config` and no longer recomputes the effective config of the live sessions. It re-keys the changed connection and stops nothing. A release re-sync still recomputes the effective config.
- `service.ts`: an attach's status capture resolves its owner when the capture runs: the attaching session's binding only while it is still that session's current binding, and nothing once the session was released. An attach that binds no session still reports its own config.

### Why

- The fence compared one process-wide `#config` object, and any attach with a different resolved config replaced it. On a multi-session host, the main session (with extension-registered servers) and sidecar sessions (without them) share one service. Each sidecar attach therefore refused every MCP tool in the main session with "MCP session or server configuration was replaced.". The refusal was permanent, because no later attach restored the identity and the main session's binding was never republished. The same last-attach config also decided which connections lived, so a sidecar attach disposed the main session's extension-registered servers.
- Once connections followed every live session's config, nothing recomputed them when a session left. A server only the released session declared therefore kept running with that session's credentials until the whole service was disposed.
- Every session's status snapshot was built from the merged config. Once connections followed every live session, a session's `/mcp` status therefore listed a peer's servers, tool catalog, server info and login status.
- Every captured status snapshot stayed in `#wireStatusBySession` until the shared service was disposed, so each closed session's snapshot outlived it on a long-lived multi-session host.
- A release re-synced whatever its reason. A reload with a live peer therefore stopped the reloading session's own servers and re-spawned them on its next attach, while the same reload with no peer kept them running.
- The skill-attach sync ran outside the attach queue. While it awaited the catalog-cache reads, a quit's release re-sync could stop servers. The skill sync then resumed with the servers it had computed before that release and re-created them. The result was a connection, and later a process, for a server no live session declared.
- A credential change re-keyed its connection only while `#config` was still the object its creating sync saw. A skill attach always assigned a new object, and an attach or release re-sync did whenever the merged config changed. After that, a changed token never re-keyed the connection: `getConnection` returned nothing, the server's tools were dropped and its calls refused.
- A session that quit while its first attach was queued had no binding, so its release returned without a re-sync. Its attach then ran anyway and adopted its config as the attaching one, so for a server name both it and a live peer declared, the closed session's config won. The peer's connection was replaced and its tools refused, and servers only the closed session declared kept running while no live session declared them.
- The re-sync checked `#disposed` only before its sync, and nothing counted it. When two sessions quit close together, the second release found no live session and no pending attach, so it disposed the service while the first release's re-sync was still stopping a server. The re-sync then resumed and created connections for the remaining servers that nothing would close.
- A reload or session switch into a runtime without the MCP builtin released the session twice: first with no reason, which dropped the binding without a re-sync, then with `reload`, which found no binding and returned. While a peer stayed live, the servers only that session declared kept running with its options and credentials.
- A connection created with one session's env stayed bound to that env while a peer resolving the same token shared it. When the first session's token rotated, the credential re-sync recomputed the key from the peer's still-matching credentials, found it unchanged and kept the stale connection. `getConnection` then returned nothing and every sharing session's calls were refused, with nothing left to re-key the connection.
- A credential re-sync recomputed the effective config from the live sessions. During a peer's reload window (released with no reason, not yet attached again) that config lacked the reloading session's servers, so a token change in another session stopped them, and the reloaded attach then re-spawned them: the restart the reasonless release had stopped doing.
- An attach's status capture fell back to the binding it created even after the session was released. A session that quit while its own attach was running therefore had its snapshot stored after the release had already deleted it, and the snapshot outlived the session.

### Why an extension could not handle it

- The fence and the connection set are private state of the MCP builtin's shared service; no extension can see or replace them.

### Expected merge conflict zones

- `McpSessionBinding`, `attachSession`, `#bind`, `releaseSession`, `#resyncToLiveSessions`, `#effectiveConfig`, `attachSkillMcpServers`, `#handleServerToolsChanged`, `#registerDirectTools`, `refreshWireStatusSnapshot`, `#refreshWireStatus`, `#statusOwner`, `#captureWireStatus`, `#captureWireStatusServer`, `#serverSnapshot`, `resolvesSameCredentials`, `#pendingSyncs`, `#queueSync`, `#releasedSessions`, `#disposeIfDeferredAndIdle` and the `#disposed` checks and the `onCredentialsChanged` closure in `#syncFromConfig` in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`.

## 2026-10-06 - Nonblocking first-turn MCP admission (senpi#2843)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`: first-turn and preview prompt assembly no longer wait for deferred remote catalog completion. They retain single-flight session attachment and compose from the known instructions; completed background registration refreshes subsequent turns.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: startup connections are backgrounded immediately, and RPC inventory reads the known catalog instead of issuing remote list requests during admission. Pending startup catalogs report a connecting state.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`: background catalog collection also retains resource templates so the local RPC inventory can present them without remote requests.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`: per-server cache updates merge under the existing bounded filesystem-lock pattern before atomic replacement, preserving different servers' concurrent updates rather than only preventing torn JSON.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`, `startup-race.ts`, `service-tools-changed.ts`, and `shared-connection.ts`: delayed writes recheck current ownership after lock acquisition, reads and temporary-file writes; retired owners cannot replace the cache. Shared writes require at least one current lease, and temporary files are cleaned on every exit.
- `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts` and `service.ts`: matching last-known metadata remains eligible regardless of age. Age triggers a nonblocking background refresh for lazy servers; config and credential mismatches still withhold metadata, and invocation checks the fresh catalog.
- `auth/{token-store,legacy-lock,legacy-migration,oauth-refresh}.ts`: background OAuth preparation acquires the existing legacy migration file lock asynchronously instead of spinning on the session event loop. Synchronous and asynchronous readers share one migration module and the same exclusive grant claim; first-provider delivery proceeds while another process owns that lock. Token persistence remains in the store.
- `invocation.ts`, `catalog.ts`, `service-register.ts`, and `expose/{register,proxy,tier-b,session}.ts`: direct, promoted, and proxy calls use one current-catalog resolver, raw-schema validation without coercion, session/configuration checks, and a final synchronous permission fence. Removed tools return a structured unavailable result without a remote call; private offered-operation identity follows deferred promotion and each proxy owns its schema identity.
- `startup-race.ts`, `service-types.ts`, `service-connection.ts`, and `service.ts`: readiness is single-flight per entry and bound to the connection generation. Successful metadata becomes available only after collection, remains in memory when persistence fails, and replaced/disabled entries cannot publish it as current.
- `shared-connection.ts`: a failed cache write warns the current lease owners but does not reject the successful live catalog or memoize failed readiness. Real-service regressions block the cache directory and retain both the first and later calls on private and shared connections.
- `permission-system/dispatch.ts`: retired authority remains required for the same session-manager lifetime, including an inline extension without a builtin path identifier. Preparation, approval and final dispatch reject retirement until a new authorizer registers. A session where enforcement was never loaded remains distinct; intentionally disabling enforcement on reload does not clear an existing retired registration and currently requires a fresh session (follow-up senpi#2873).
- `expose/call.ts` and `expose/register.ts`: connection readiness and bounded renewal complete before the narrowly classified failed-send retry; each actual retry still resolves current metadata and permission before dispatch. The invocation deadline uses the existing safe timer and output error path.
- `expose/tier-b.ts`: selected catalog refresh retains previously promoted current tool definitions, including default search promotion, without restoring vanished or remapped operations.
- `service.ts`: OAuth inventory uses a local credential snapshot without token migration. Revoked credentials retain public re-authentication guidance and `needs_auth` status while obsolete transports, catalog entries, and server metadata remain unavailable.
- `service.ts`: attaching a peer with an identical resolved configuration preserves the current configuration object, so that peer's attach and later teardown cannot retire another live session's invocation fence. An actual configuration change still replaces the object and invalidates prior offers; binding, connection and credential checks remain independent.
- `auth/catalog-identity.ts`, `catalog-cache.ts`, `service.ts`, `service-connection.ts`, `service-types.ts`, `connection-types.ts`, `sharing-policy.ts`, `shared-connection.ts`, `startup-race.ts`, `service-tools-changed.ts`, and `service-register.ts`: opaque credential fingerprints bind cached metadata and connection ownership. Local OAuth snapshots never invoke token migration or refresh. A changed credential withholds prior tools, instructions, and RPC metadata; selected readiness replaces only that owner's connection, and final dispatch rejects obsolete credentials. Token rotation conservatively invalidates cached metadata and Once evidence instead of inferring account continuity.

### Why

- A cold MCP catalog delayed the first provider request even when the message required no MCP tool. A held local catalog response reproduces the admission barrier through the real session and extension harness.

### Why an extension could not handle it

- The wait belongs to the existing MCP builtin's prompt hook and cannot be removed by another extension.

### Expected merge conflict zones

- Single-flight attachment and `before_agent_start` in `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`.
- Startup synchronization and wire inventory in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`; collection and normalization in `packages/coding-agent/src/core/extensions/builtin/mcp/catalog-cache.ts`.

## 2026-10-09 - Concurrent log rotation never disables a log sink (senpi#2976)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/log.ts`: `FileMcpLogger` rotates through `rotateLogIfNeeded` (its private `#rotateIfNeeded` is gone) and its file sink retries after `LOG_SINK_RETRY_MS` instead of staying disabled for the process lifetime; the ring buffer still records the failure.

### Why

- Several processes share one agent dir (engine host, CLI, desktop host). Rotation was a non-atomic stat, remove `.1`, rename: when two crossed the cap together, the loser's rename threw ENOENT and its sink stayed disabled for the rest of the process, and the remove step could delete a generation another process had just rotated. A four-process burst dropped hundreds of lines per losing process. Rotation now goes through `core/log-file-rotation.ts` (an exclusive lock file and a size re-check under it), a lost race keeps appending, a failed sink retries after `LOG_SINK_RETRY_MS` (5 s), and the mode is set on the open descriptor.

### Why an extension could not handle it

- This is the builtin extension's own log writer.

### Expected merge conflict zones

- LOW: `FileMcpLogger.#writeFile` in `mcp/log.ts`.

## 2026-10-04 - Interactive MCP server manager (senpi#2716)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`: blank `/mcp` opens a custom manager in TUI mode; non-TUI status and existing subcommands remain unchanged.
- `packages/coding-agent/src/core/extensions/builtin/mcp/manager.ts` and `manager-view.ts`: compact server rows, state-specific actions, tool/detail/log screens, configured keyboard navigation, bounded lists, and event-driven refresh preserving selected identity. Existing connection/catalog subscriptions and auth/test/reconnect handlers are reused; subscriptions and stale async renders are discarded on exit.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config-edit.ts`: selected global/project definitions can persist enable/disable and exposure changes without expanding placeholders or rewriting other servers. Imported, extension, skill, and untrusted sources are not editable in the manager.
- Review follow-ups: manager display text strips remote terminal controls while selected values remain unchanged; manager commands pass raw server names without reparsing; OAuth actions follow stored token status rather than connection state.
- Owner context fix: `packages/coding-agent/src/core/extensions/builtin/mcp/manager.ts` passes the original guarded command context to Test/Reconnect and captures notices through a private optional callback; `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts` forwards that callback without copying context/UI or changing the extension API.

### Why

- The prior panel used verbose diagnostics as a generic selector's title, making multiple servers difficult to inspect and manage. Upstream Pi's dedicated manager supplies a compact reference while Senpi retains its own MCP runtime and exposure modes.
- Original context identity, live UI/mode getters, and stale-session guards must survive reconnect's service binding; notice capture must not freeze or mutate session context.

### Why an extension could not handle it

- This is implemented inside the existing MCP builtin through `ctx.ui.custom`; no core UI or extension API changes are needed. The builtin owns its resolved server metadata and command handlers.

### Expected merge conflict zones

- Blank-command dispatch in `commands.ts` and validated config updates in `config-edit.ts`; the manager modules are fork-only.
- Private Test/Reconnect notification parameters in `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`; callback dispatch in fork-only `packages/coding-agent/src/core/extensions/builtin/mcp/manager.ts`.

## 2026-10-03 - A deferred MCP dispose settles before its release returns

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: when `releaseSession()` has to defer the dispose behind pending attaches, it now waits for them, then disposes (or settles without disposing if a live session bound meanwhile). The wait is bounded by `SENPI_MCP_DEFERRED_DISPOSE_TIMEOUT_MS` (default 15 s); past it the service disposes anyway and logs a warning.

### Why

- `session_start` starts the attach without awaiting it. Removing the MCP builtin during a reload while that attach was in flight returned with the service and its servers still alive and disposed them only later, so `test/mcp/extension-load.test.ts` ("disposes the preserved classic singleton...") failed nondeterministically (17 of 50 local runs). A caller awaiting a release now sees the servers gone.

### Why an extension could not handle it

- The disposal order lives inside the builtin MCP service; no extension hook can wait on its attach queue.

### Expected merge conflict zones

- LOW: `releaseSession()` and `#disposeIfDeferredAndIdle()` in `service.ts`.

# mcp Extension Changes

## 2026-10-01 - Give each session its own binding to the shared MCP service (senpi#2514)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: the single `#pi` / `#toolSearchService` / `#tierBRegistration` binding is replaced by one `McpSessionBinding` per attaching extension API, keyed by that `pi`. Only the process-wide service `getMcpService()` builds (`servesManySessions: true`) holds several bindings; a session-owned service (the RPC host, a host registry, provider scopes) keeps exactly one, and a new attach takes it over as before. Each binding resolves its session's tool-search service per call (`getToolSearchServiceForExtension(pi)`, with the old sessionless fallback for hosts without one) and keeps its own registration and per-server registered identity. A late startup catalog and every list_changed refresh register on all live bindings; a binding whose session retired its tool-search service is dropped. `releaseSession(pi, disposeReason?)` releases one binding and disposes only when no live binding remains. The binding-reading methods (`getTierBSearchable`, `getMcpPromptServers`, `getMcpResourceServers`, `activateSkillMcpTools`, `attachSkillMcpServers`, `rehydrateActiveToolsFromHistory`, `maybeRehydrateFromHistory`) take the caller's `pi`; without one they read the most recently attached live session, for single-session SDK and test callers.
- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`: the classic (non-provider-scoped) path passes its own `pi` to those methods and releases its binding on `session_shutdown` and on `session_extensions_removed`, disposing only for the last live session (`quit`, or `reload` when the builtin is removed). The provider-scoped path is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-tools-changed.ts`: `refreshMcpToolsOnListChanged` takes a resolver of the live sessions and re-registers the sessions whose registered identity is stale. It resolves again after registering, so a session that attached while the refresh was listing tools also gets the refreshed catalog. One session's registration failure is collected and reported after the others registered, never aborting them.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` (review follow-ups): a session whose extension load owns no tool-search service takes the process-wide fallback only when no other live session holds it, and otherwise gets its own `ToolSearchService`. Attaches are counted from the moment they queue (`#pendingAttaches`), so `releaseSession` never disposes the service under an attach that has not bound yet. An attach that reaches a disposed service throws instead of opening connections nobody owns. The late startup catalog registers on each live session independently and reports failures together.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`: the registered catalog identity moves from the shared connection entry to the session binding (`onRegistered` option).

- Review follow-up: a catalog that lands after the startup window registers in every live session unless the service was disposed or the connection replaced (a later attach no longer cancels it), and a session that quits while its own attach is still queued is not bound; the last pending attach disposes the service once no session is left.

### Why

- Outside the RPC host every session shares the module-level service, and each attach overwrote the one binding. A catalog that landed late or changed reached only the last session; after that session was replaced the others resolved through its stale context; and one session's quit disposed the servers every other session was using. Connections stay shared on purpose: a session that resolves the same server config (same `configHash`) reuses the existing connection, so it neither re-spawns the server nor re-runs OAuth; only the binding becomes per session. Sharing is per config: an attaching session whose resolved config for a server differs (for example another project's `.senpi/mcp.json`) still makes `#syncFromConfig` replace that server's connection, as before this change.

### Why an extension could not handle it

- The binding is internal state of the MCP builtin's service.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: the field block, `attachSession`, the startup-race `registerDirectTools` callback, `#handleServerToolsChanged`, `#registerDirectTools`, and the rehydration methods.
- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`: the `session_shutdown` and `session_extensions_removed` handlers.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-tools-changed.ts`: the target loop in `refreshMcpToolsOnListChanged`.


## 2026-10-02 - Optional OAuth fields and list cursors sent as null (upstream v1.0.0 sync)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-fetch.ts` (new): wraps the fetch used for OAuth discovery, registration, token and refresh calls and drops optional fields (`expires_in`, `refresh_token`, `scope`, `id_token`, `client_secret` and registration metadata) whose value is `null` or `""`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth-refresh.ts`: every SDK OAuth call goes through that fetch.
- `packages/coding-agent/src/core/extensions/builtin/mcp/transport-sdk.ts`: stdio and HTTP transports drop `nextCursor: null` from list results before the client parses them.

### Why

Upstream fixed the same server quirks in its MCP package (8ce69e9d2). The SDK rejects `null` for these fields, and coerces `expires_in: null` to 0, which stored an already-expired token; a `nextCursor: null` failed the whole tool listing.

### Why an extension could not handle it

The OAuth calls and transports are built inside this builtin.

### Expected merge conflict zones

The fetch wiring in `oauth.ts`/`oauth-refresh.ts` and transport construction in `transport-sdk.ts`.

## 2026-10-02 - RFC 9207 issuer check on MCP authorization responses (upstream v1.0.0 sync)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/oauth.ts`: before the authorization code is exchanged, an `iss` that differs from the discovered issuer, or a missing `iss` when the authorization server advertises `authorization_response_iss_parameter_supported`, fails the sign-in.
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/callback.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts`: the loopback callback and the pasted redirect carry `iss` to that check.

### Why

Upstream added the same check (d850edee9) to block authorization-server mix-up attacks. Its `oauth.authServerMetadataUrl` setting is an upstream MCP-extension feature and is not taken.

### Why an extension could not handle it

The authorization response is handled inside this builtin's OAuth flow.

### Expected merge conflict zones

`finishAuthorization` and `parseRedirect` in `oauth.ts`.

## 2026-10-02 - OAuth credentials per server name and URL (upstream v1.0.0 sync)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`: the credential directory is keyed by server name and URL; a record stored by URL alone moves to the first server that reads it, and signing out also removes the URL-keyed record that server would take over.

### Why

Upstream fixed the same defect (5806068c2): two servers with the same URL (for example a work and a personal account) shared one token, and signing out of one signed the other out.

### Why an extension could not handle it

The token store is this builtin's own persistence.

### Expected merge conflict zones

The directory key in `McpTokenStore`.

## 2026-10-01 - Skill MCP declarations are cached by file stamp (senpi#2508)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/skills.ts`: `readSkillServers` keeps each skill's parsed declarations keyed by the mtime and size of its `mcp.json` sidecar and `SKILL.md`, and re-reads only when either changes.

### Why

`before_agent_start` parses every skill's declarations on every turn; re-reading and re-parsing each file stalled each background-triggered turn.

### Why an extension could not handle it

This is the builtin MCP extension's own skill scan.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/skills.ts`: `readSkillServers`.
## 2026-10-01 - Feed the attaching session's tool-search service (senpi#2509)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `attachSession` resolves the attaching session's tool-search service; the fallback for callers without a loaded extension is unchanged.

### Why

- The tool-search builtin no longer keeps one module-level service for every session, so the MCP service must feed the catalog of the session it attaches to. This change only plumbs that lookup; the MCP service itself is still shared in-process (follow-up senpi#2514).

### Why an extension could not handle it

- The tool-search lookup is internal to the MCP builtin.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: the tool-search import and the activation-runtime block in `attachSession`.

## 2026-09-29 - list_changed re-registers a non-shared connection's current listing (#2188)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service-tools-changed.ts`: before a list_changed refresh re-registers, a non-shared connection re-collects its catalog with `collectServerCatalogForCache`, stores it on `entry.cachedCatalog`, and writes it to the on-disk catalog cache, as a shared lease's `catalog()` already does. Until the first refresh has recorded names, the removal diff starts from the catalog the session last registered.

### Why

- Registration reads `entry.cachedCatalog`, and on a non-shared connection only the startup connect filled it. A list_changed re-listed the server only to diff names and then re-registered the startup catalog, so added tools never registered and removed tools were registered again on top of their tombstones.
- The first refresh had no recorded names to diff against, so a change that arrived inside the coalescing window of the connect's own relist tombstoned nothing.

### Why an extension could not handle it

- The list_changed refresh and the connection's catalog cache are internal to the MCP builtin.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service-tools-changed.ts`: `refreshMcpToolsOnListChanged` between the startup-claim early return and the tombstone loop, and its imports.

## 2026-09-29 - Skill-declared servers expand ${VAR} by the skill's trust (#2345)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/skill-server.ts` (new; `resolveSkillMcpServer` moved here from `config.ts`): a skill-declared stdio server from a trusted source (user, temporary or system scope, or project scope while the project is trusted) is interpolated with the same `interpolateValue` as trusted `mcp.json`; an untrusted project's stdio server stays literal and returns one warning naming the skill and the variables; a remote server from any skill keeps `url`/`headers` literal and drops a bearer-attaching `bearerTokenEnv` (setting `auth: false`), with one warning each. A server asking for command substitution is skipped with a warning instead of throwing.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`: exports `normalizeServer`, `interpolateValue` and `hashConfig` for `skill-server.ts`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/skills.ts`: `SkillLike.sourceInfo.scope` and `SkillServerRegistration` (first declaring skill's name and scope) travel with each declaration.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `attachSkillMcpServers` takes `SkillServerRegistration`s, derives trust from the scope plus the session's project trust, and returns each trust warning once per session.
- `packages/coding-agent/src/core/extensions/builtin/mcp/index.ts`: passes the parsed declarations straight through.

### Why

- Skill servers skipped `${VAR}` expansion, so the documented `"env": { "EXA_API_KEY": "${EXA_API_KEY}" }` spawned the child with the literal placeholder. A stdio child sees only the SDK's allowlisted environment plus `env` (`transport-sdk.ts`), so expansion decides which parent variables a skill-chosen command receives: user-owned skills get what trusted `mcp.json` gets, an untrusted project's skill gets nothing. Remote servers never expand, and `bearerTokenEnv` from a skill is dropped, because both would send a parent variable to a URL the skill chose.

### Why an extension could not handle it

- Skill server resolution and registration are internal to the MCP builtin.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `attachSkillMcpServers` signature and loop, the `#skillServerWarnings` field, the `attachSession` prologue.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`: the removed `resolveSkillMcpServer` and the `export` keywords.
- `packages/coding-agent/src/core/extensions/builtin/mcp/skills.ts`: `SkillLike` and the declaration record.

## 2026-09-27 - Register a raced startup catalog exactly once (#2177)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`: `raceMcpStartupConnect` puts a `startupCatalogClaim` on the connection entry for as long as the startup connect owns the server's first catalog registration, and releases it when the connect settles, right before a backgrounded refresh registers the catalog.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`: `McpStartupCatalogClaim` (the catalog the entry had when the connect began, and whether the claim still owns registration) and the optional `startupCatalogClaim` entry field.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`: while a claim owns registration, a registration pass uses the claim's starting catalog and does not list a connected-but-unrefreshed server itself. Each pass records the `mcpRegistrationIdentity` (`packages/coding-agent/src/core/extensions/builtin/mcp/catalog.ts`: tools, resources and prompts) of what it registered as the entry's `registeredIdentity`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection-types.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts`: tools-changed events carry a `cause`: `connect` for the signal every successful connect raises, `notification` for everything else (list_changed, resource_updated, owner renewal, explicit `markToolsChanged()`). Shared leases forward the cause.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-tools-changed.ts` (the coalesced subscription and `#handleServerToolsChanged`, moved out of `service.ts`): a refresh whose merged signals all came from connects leaves an unchanged registration alone and yields to a startup claim that still owns registration. Any reported change re-lists and re-registers as before.

### Why

- When the startup-race deadline fell after `connect()` but before the catalog refresh finished, the attach pass listed the catalog itself and the backgrounded refresh then registered it again: two `tools/list` round trips, every tool registered twice, and two concurrent registration passes. The by-name tool registry hid the duplicates from provider requests, but the MCP threshold test counted 22 registrations for 11 tools.
- Every connect, the first one included, raises the tools-changed signal so a reconnect re-lists. 300ms after startup that relist re-registered the catalog the startup connect had just registered. A connect whose listing changed still re-registers (`recovery-reregister.test.ts`), and reported changes keep their re-registration (`host-registry-sharing-lifecycle.test.ts`).

### Why an extension could not handle it

- The startup race and the registration pass are internal to the MCP builtin.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`: `raceMcpStartupConnect` prologue.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-register.ts`: entry mapping.
- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/session.ts`: live-catalog branch and listing record of `registerDirectMcpTools`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `#wireListChanged` and `#handleServerToolsChanged` now delegate to `service-tools-changed.ts`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`: `markToolsChanged` signature and the post-connect call.

## 2026-09-23 - Keep native OAuth authorization usable (oh-my-openagent#6724)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth-dispatch.ts` calls the existing shell-free browser launcher and emits UI-only transcript entries for auth notices.
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts` presents the full URL before opening the browser, retains paste instructions, and lets manual authorization continue if the opener rejects.
- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts` renders auth entries through the shared notice renderer. These entries never enter model context.

### Why

- Native auth previously substituted a transient notification for the browser launcher, then overwrote that URL with another status notification. A user could neither open the browser nor recover the link.

### Why an extension could not handle it

- The MCP builtin owns the command dispatch and OAuth provider callback; its own `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth-dispatch.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts` must expose and launch the URL.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth-dispatch.ts`: UI/browser dependencies.
- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/commands-auth.ts`: interactive authorization announcements.
- `packages/coding-agent/src/core/extensions/builtin/mcp/commands.ts`: renderer registration.

## 2026-09-21 - Share eligible connections in the in-process host (#1921)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-connection.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts` add host-owned shared transports and session-owned views. The host owns reconnect, aggregate idle/keep-alive, one catalog writer, notification fan-out and unambiguous in-flight elicitation routing.
- `packages/coding-agent/src/core/extensions/builtin/mcp/sharing-policy.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` preserve session-template provenance across interpolation and key physical connections by resolved transport/auth configuration and agent directory.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts` extracts connection creation/disposal from `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`; sharing is enabled only for an injected host registry. `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` delegates shared cache refresh to the host.

### Why

- Equal eligible configurations previously opened one physical MCP transport per session. `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-connection.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts` now retain one transport without allowing one session to close or renew another session's connection.
- `packages/coding-agent/src/core/extensions/builtin/mcp/sharing-policy.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` prevent cwd/session-dependent stdio servers from joining the pool, including after interpolation erases the original template.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` keep standalone lifecycle behavior and per-session exposure separate from host ownership.

### Why an extension could not handle it

- The builtin owns physical connection construction, SDK handlers and catalog writes. `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-connection.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` must coordinate at that boundary; an outside extension cannot multicast handlers or identify a call's owner.
- Raw config provenance is available only in `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts`; `packages/coding-agent/src/core/extensions/builtin/mcp/sharing-policy.ts` carries it without changing the persisted catalog hash.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` connection reconciliation, `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts` connection factory and `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts` cache refresh.
- `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/shared-connection.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts`: host ownership and request routing.
- `packages/coding-agent/src/core/extensions/builtin/mcp/config.ts` interpolation and `packages/coding-agent/src/core/extensions/builtin/mcp/sharing-policy.ts` eligibility/identity. No SDK version or session protocol change.

## 2026-09-21 - Host-owned connection leases with sharing disabled (#1915)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts` adds object-owner reference counts, immediate final-detach disposal, owner enumeration and a typed unknown-owner error. `shareable` returns false for every configuration.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` obtains connections through an injected registry, or a new instance-owned registry for standalone services, and detaches leases during existing disposal.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts` carries the optional registry in `McpSessionOptions`.

### Why

- `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`, `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` and `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts` establish explicit ownership before any future connection sharing. Equal configurations still create separate connections for different services.

### Why an extension could not handle it

- Connection construction and disposal in `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts` are private to the builtin. The lease contract in `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts` and injection option in `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts` must reach that owner.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: constructor, `#syncFromConfig` and `disposeEntryConnection`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-types.ts`: `McpSessionOptions`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/host-registry.ts`: future sharing policy and lifecycle routing. This change does not enable sharing or alter idle, reconnect, cache, keep-alive or elicitation behavior.

## 2026-09-21 - Catalog cache writes bind to the attach-time agent dir (senpi#1904)

### What changed

- `service.ts`: `attachSession` resolves the agent dir once at attach time (`options.agentDir ?? getAgentDir()`) and threads the resolved value through the session options, so config loading, the auth plan, and every `McpConnectionEntry.agentDir` carry the attach-time directory instead of `undefined`.
- `startup-race.ts`'s backgrounded `writeMcpCachedServer(entry.agentDir, ...)` (and every later reconnect rewrite through the same entry) therefore writes into the attach-time directory; `catalog-cache.ts`'s write-time `getAgentDir()` default is no longer reachable from a default-attach session.
- `test/mcp/catalog-cache-agent-dir.test.ts` (new): attaches through the default path with the env at dir A, flips the env to dir B before the backgrounded catalog write resolves, and asserts the cache lands under A, never B.

### Why

- The default attach path (interactive/RPC sessions) passes no `agentDir` option, so entries carried `undefined` and the backgrounded cache write re-resolved the directory from the environment at write time. Any env change between attach and that write - per-test env restore racing a backgrounded connect being the observed case - deposited catalog entries into a foreign agent directory: a real agent dir's `cache/mcp-cache.json` carried `fixture` (2026-08-29) and `fx` (2026-08-31) entries written by test runs. A decoy-dir sentinel reproduced it on an unfixed tree: the quarantine-bypassing runner (`bun test`, which skips `test/setup.ts`) mutated the decoy's cache while the quarantined vitest run left it byte-identical. On the fixed tree the vitest run still leaves the decoy byte-identical, and `bun test` mutates it only through the one test that attaches with the ambient lanes resolved (extension-load's extension-declared case) - that write now follows the attach-time directory by design, which on that path is the ambient decoy on both trees; the env-flap class (every env-managed attach) no longer reaches the decoy. Shielding tests that attach with ambient lanes remains the quarantine's job (`test/setup.ts`, untouched).

### Why an extension could not handle it

- The connection entry, the startup-race continuation, and the cache write are private to the MCP builtin; no public extension API exposes or overrides the write-time directory.

### Expected merge conflict zones

- LOW: `service.ts` `attachSession` top (the session-options resolution and the four call sites that consume it).
- LOW: `test/mcp/catalog-cache-agent-dir.test.ts` (new file).
- MEDIUM: concurrent MCP PRs touching `service.ts` `#syncFromConfig` entry construction or the attach closure.

## 2026-09-17 - The prompt build observes the deferred attach (senpi#1797)

### What changed

- `startup-race.ts`: the connect that the startup race backgrounds is now handed to the caller through a required `onDeferred` option, and `McpDeferredAttach` holds those continuations as the attach's completion signal. `MCP_ATTACH_SETTLE_TIMEOUT_MS` (5 s) bounds anyone waiting on it; a connect that fails still settles the attach and is logged there, where it is finally handled.
- `service.ts`: `#syncFromConfig` tracks every backgrounded connect, `whenAttachSettled(timeoutMs)` exposes the bounded wait, and `dispose` drops the pending set.
- `index.ts`: `before_agent_start` awaits `whenAttachSettled()` before `injectMcpInstructions`, so the system prompt is assembled from a settled catalog; a timeout logs one warning and the turn still goes out.
- `test/mcp/attach-prompt-ordering.test.ts` (new): drives the production seam with a zero startup window (`SENPI_MCP_STARTUP_TIMEOUT_MS=0`), so the attach is always deferred, and pins the instructions block, the turn-1 tool payload, and the connection state at prompt-build time.

### Why

- `attachSession` resolves at the startup-race deadline, not at connect completion, so `before_agent_start` was awaiting a promise that says nothing about the server being read. The instructions snapshot taken at attach time then held the cached (or empty) generation for the whole session, and turn 1's payload carried no MCP tools. On a fast machine the connect won the race and hid it; senpi#1797 caught it on a 534 s CI shard, twice, on a branch whose diff touches no MCP file.
- Reproduced deterministically with the existing product knob: with `SENPI_MCP_STARTUP_TIMEOUT_MS=0`, `test/mcp/instructions.test.ts > keeps same-session instructions byte-identical until a new session starts` fails on main at the same assertion CI failed on, and passes with this change.
- The wait is bounded rather than open-ended because each connect is already bounded by the server's `connectTimeoutMs` (15 s default); 5 s is the point where the user's turn stops paying for a wedged server and takes the catalog on a later turn instead.

### Why an extension could not handle it

- The startup race, the single-flight attach promise, and the session instructions snapshot are all private to this builtin; nothing outside it can observe when a backgrounded connect has settled, and `before_agent_start` ordering inside the builtin is what decides the first turn's prompt.

### Expected merge conflict zones

- LOW: the `raceMcpStartupConnect` tail in `startup-race.ts` and the `raceMcpStartupConnect({...})` option block in `service.ts`.
- LOW: the `before_agent_start` body in `index.ts` between the skills block and `injectMcpInstructions`.

## 2026-09-17 - Do not await attach inside session_start (senpi#1781)

### What changed

- `index.ts`: the `session_start` handler no longer returns its attach promise to the runner. Attach still starts there and stays single-flight; `before_agent_start` already awaited `attachPromise`, so the first turn's payload is unchanged.
- `commands.ts`: `registerMcpCommands` takes a `pendingAttach` accessor and every `/mcp` subcommand awaits it, so the command reports attached state rather than a half-connected snapshot now that startup no longer blocks on it.

### Why

- `session_start` is dispatched serially by `ExtensionRunner`, so this handler was on the first-paint path. Per-handler attribution across all ~28 registered handlers measured this one at a 255 ms median of a 292 ms total dispatch against a real config, and 0.2 ms with no servers configured. Deferring it moved time-to-ready from a 1,014 ms median to 797 ms (n=10, interleaved arms).
- The configured default-tool set still applies to late-registered MCP tools: `_refreshToolRegistry` filters by `_defaultToolNames` on every registration, not only in the one-shot pass that runs after the emit.

### Contract re-specified

- `test/suite/mcp-reload-deferral.test.ts` previously pinned "reload defers, startup awaits". That scope was deliberate but predated the measurement; the file now pins that **every** reason defers, and adds the invariant that makes it safe: `before_agent_start` holds until the startup attach completes, so turn 1 still carries the tool set. Both directions are mutation-proven.

### Expected merge conflict zones

- LOW: the `session_start` registration block in `index.ts` and the `registerMcpCommands` signature.
- MEDIUM: `test/suite/mcp-reload-deferral.test.ts` — three of its four cases changed expectation.

## 2026-09-17 - Load the MCP SDK on first use, not at every CLI start (senpi#1781)

### What changed

- New `sdk.lazy.ts` holds memoized loaders for the SDK submodules the builtin needs (client, stdio and streamable-HTTP transports, auth, types); a failed load is not cached so a later attempt retries, and concurrent callers share the in-flight promise.
- New `transport-sdk.ts` owns the SDK-typed transport construction that `transport.ts` used to import statically, new `notification-schemas.ts` declares the subscribed notification schemas locally, and new `needs-auth.ts` recognizes an unauthorized error without importing the SDK's error class.
- `connection.ts`, `health.ts`, `diagnose.ts`, `elicitation.ts`, `notifications.ts`, `resources.ts`, `logging.ts`, `wrap.ts` and the OAuth modules keep type-only SDK imports and await the loaders on their already-async paths.

### Why

- The SDK is 210 files / ~1.16 MB and the mcp builtin is statically reachable from the builtin barrel, so every start parsed and evaluated the whole SDK (about 70ms of module evaluation) although attach is already deferred to first use. Removing those static edges takes 213 modules out of the startup graph.

### Why an extension could not handle it

- The mcp builtin is the in-tree owner of the SDK graph; an outside extension cannot change its static imports.

### Expected merge conflict zones

- MEDIUM: `transport.ts` (the construction moved to `transport-sdk.ts`) and the notification-schema imports in `notifications.ts` / `resources.ts` / `logging.ts`.
- LOW: the unauthorized-error checks in `connection.ts` and `health.ts`.

## stubSwap stubs promote themselves on the first by-name call (2026-09-14, senpi#1682)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/expose/tier-b.ts`: `buildMcpStubDefinition(name, promotion?)` takes the full definition plus a `promote` hook. A stub registered under `stubSwap` now accepts arbitrary arguments (`additionalProperties: true`); on execute it calls `promote()` (the tier-B `activate` hook, which swaps stub -> full) and then runs the full definition with the same call, so the model's first by-name call both activates and executes the tool in one turn. Without a promotion hook the stub keeps its old "use tool_search" answer. Description and render label say "deferred" instead of "inactive". A module-level `promotedNamesByRegistrar` remembers every name `swapStubsToFull` promoted, and the stubSwap branch keeps those names registered as full definitions on re-registration: a cold lazy server's background connect (`raceMcpStartupConnect` -> `#registerDirectTools`) or a `list_changed` re-list rebuilt the whole catalog and used to hand a just-promoted tool back to the model as a stub, which surfaced as a timing-dependent failure in `test/mcp/exposure-tierb.test.ts`.

### Why

- `tool_search` no longer activates anything (senpi#1682), so the only remaining activation path is the by-name call. Under `stubSwap` the stub is already resident and active, which means `resolveUnknownToolCall` never fires for it; without this change a stubbed tool could never be promoted again.

### Why an extension could not handle it

- The stub definition and the swap hook are owned by the MCP builtin's tier-B registration; nothing outside it holds the full definitions or the `stubbed` set.

### Expected merge conflict zones

- LOW: the stub builder at the bottom of `tier-b.ts` and the one `toRegister` map in `registerMcpTierBTools`.

## Explicit pgrep match-all pattern for process-tree collection (2026-08-12)

### What changed
- `process-tree.ts` now passes `.` as the positional match-all pattern to `pgrep -P`.
- `killPids` now skips any non-positive or PID-1 entry before signaling, as defense in depth against a broken or substituted discovery executable returning a catastrophic target.
- `test/suite/regressions/issue-823-mcp-pgrep-pattern.test.ts` places a deterministic fake `pgrep` first on PATH and proves unrelated PIDs are excluded, and that PID 1 is never signaled even when discovery returns it.
- `test/mcp/transport.test.ts` uses the same explicit pattern in its child-PID helper.

### Why
- Some `pgrep` implementations interpret `pgrep -P <parent>` without a positional pattern as a broad process query. The explicit `.` keeps collection limited to the requested parent on macOS and Linux.

### Why extension system couldn't handle this alone
- MCP stdio shutdown owns the private descendant-collection helper; an external extension cannot change the process tree selected before shutdown.

### Expected merge conflict zones
- LOW: `process-tree.ts` `childPids`; `test/mcp/transport.test.ts` test-only child discovery helper.

## Anthropic native deferral delegated to shared tool search (2026-08-11)

### What changed
- Removed MCP's provider-request/response native-search handlers and bound only the session's resolved `nativeToolSearch` setting into the shared tool-search adapter.
- Kept the former MCP module path as a compatibility re-export for existing internal imports; implementation ownership now lives under the shared builtin.

### Why
- One session-scoped adapter must inject inactive schemas from both MCP and extension catalog sources, enforce one 400 fallback state, and avoid duplicate provider hooks.

### Expected merge conflict zones
- LOW: `index.ts` beside command and session lifecycle registration.
- LOW: `expose/native-search.ts` compatibility re-export.

## Shared tool-search catalog feeder (2026-08-11)

### What changed
- Tier-B MCP registration now feeds MCP tool documents and a stub-aware activation hook into the shared tool-search service instead of registering a separate MCP-owned `tool_search` definition.
- MCP promotion, eval lazy activation, skill reveal, and ownership-aware/legacy rehydration all route through the same feeder hook.
- Active-set ordering now identifies sortable tools by shared catalog membership while preserving base-tool reference order; legacy stale MCP registrations are still removed during catalog replacement.
- The superseded MCP-local search tool, BM25 engine, and lazy-activator modules were removed. Proxy mode now uses the shared BM25 engine without changing its gateway contract.

### Why
- A single registered search tool must cover both MCP and extension catalogs without duplicate builtin-name precedence or split activation history.
- Routing every matched name through the MCP hook preserves stub-to-full replacement even when a stub is already active.

### Why extension system couldn't handle this alone
- MCP retains ownership of exposure policy, naming, proxy mode, stub swapping, skill-carried server reveal, and catalog refresh generations; only the builtin can translate those semantics into the shared catalog contract.

### Expected merge conflict zones
- HIGH: `expose/tier-b.ts`, `expose/session.ts`, `service.ts`, and `index.ts` around catalog registration and lifecycle wiring.
- MEDIUM: MCP search, rehydration, and eval test suites now target the shared service.

## Session-scoped control inventory bridge (2026-08-11)

### What changed
- The MCP service now captures wire inventory for RPC sessions as well as app-server threads and serializes explicit
  refreshes so concurrent connection/catalog transitions cannot overwrite a newer snapshot.
- Live snapshots include the server's connection/config state and notify session-local listeners only after the
  machine-readable inventory changes.
- The builtin registers a private resource-event-bus bridge for the control host to request and subscribe to its own
  session's snapshot. Lifecycle teardown removes both request and change listeners on reload, replacement, and quit.

### Why
- Multi-session RPC creates one MCP service inside each provider scope, so the process-global classic getter cannot
  identify the service belonging to a routing handle. The bridge keeps MCP status/tool inventory attached to the same
  session that loaded it and prevents cross-session leakage.

### Why extension system couldn't handle this alone
- The MCP builtin can expose its private service through the extension event bus, but only the RPC host can correlate
  that inventory with control requests and emit routed invalidation events.

### Expected merge conflict zones
- LOW: `index.ts` session lifecycle wiring.
- MEDIUM: `service.ts` wire-status refresh and notification paths.
- LOW: additive `control-inventory.ts` and status metadata in `service-types.ts`.

## Strip invalid null-valued MCP schema types (2026-08-04)

### What changed
- `expose/schema-compat.ts` now omits JSON-null `type` keywords while
  recursively resolving MCP tool input schemas into TypeBox definitions.
- Valid JSON Schema null types remain unchanged, including `type: "null"` and
  union arrays such as `type: ["string", "null"]`.
- `test/mcp/schema-compat.test.ts` covers root, nested property, and combiner
  branch null values plus both valid null-type forms.

### Why
- Some MCP servers emit `type: null`. JSON Schema permits the string `"null"`
  but not the JSON null value; strict OpenAI-compatible providers reject the
  malformed tool definition with HTTP 400 before the model can answer.
- Sanitizing at MCP conversion protects every provider adapter that receives
  the registered tool, rather than patching one provider-specific wire path.

### Why extension system couldn't handle this alone
- The MCP builtin owns conversion from external `tools/list` schemas to the
  registered `ToolDefinition`. Other extensions cannot rewrite that private
  schema conversion before the tool enters the shared provider pipeline.

### Expected merge conflict zones
- LOW: `expose/schema-compat.ts` recursive `$ref` copy loop.
- LOW: `test/mcp/schema-compat.test.ts` schema-conversion cases.

## Session-expiry retry uses the full service reconnect (2026-08-03)

### What changed
- `health.ts` now routes a session-expired tool call through
  `reconnectMcpNow()` before retrying, instead of renewing only the transport.
- The retry therefore reuses the same service callback as
  `/mcp reconnect <server>`: reset reconnect state, refresh auth, invalidate
  catalog readiness, renew the transport, recollect the catalog, update cache
  metadata, and restore resource subscriptions.
- The retry remains bounded to one attempt. A renewed session that also
  expires is still marked suspended with the existing actionable reconnect
  guidance.

### Why
- Some MCP servers require a fresh catalog/list handshake after a new transport
  session is initialized. Thin `connection.renew()` skipped that handshake, so
  the retry immediately expired again and left the server suspended even
  though the explicit `/mcp reconnect` path could recover it.

### Why extension system couldn't handle this alone
- The recovery must invoke the process-owned MCP service's private reconnect
  callback, which owns auth refresh, catalog cache state, and subscriptions.
  An external extension can call the exposed tool but cannot replace the
  builtin's guarded tool-call retry boundary.

### Expected merge conflict zones
- LOW: `health.ts` session-expiry retry branch.
- LOW: HTTP MCP fixture options and session-expiry regression tests.

## Classic reload preserves unchanged MCP servers (2026-07-26)

### What changed
- Classic (non-provider-scoped) MCP reloads keep the shared `McpService` alive. The reload-time `session_start` reattaches it and its existing config-hash reconciliation preserves unchanged servers while replacing changed definitions and disposing removed definitions.
- Provider-scoped MCP services still dispose on `reload`, because rebuilding an extension factory creates a new scoped instance and preserving the old one would orphan its child processes.
- Core now emits `{ type: "session_extensions_removed", reason: "reload", removed: Array<{ path, resolvedPath }> }` on the old runner after it knows the rebuilt extension set. MCP matches its builtin identity (`<builtin:mcp>`) in that event and disposes the preserved classic service when MCP is disabled during a reload.
- `/mcp reconnect <name>` remains the explicit escape hatch for a server that is connected but wedged: it renews that server without requiring a full reload.

### Why
- Spawning every MCP server again on every classic reload adds a fixed process startup cost even when config is unchanged. Preserving and reconciling retains healthy children, while the removal event closes the only gap where the preserved singleton otherwise loses its owning extension.

### Why extension system couldn't handle this alone
- The core alone can identify removed extension entries but must remain resource-agnostic; MCP alone cannot know the post-reload builtin set at `session_shutdown`. The core event provides the lifecycle boundary and MCP owns the service-specific disposal.

### Expected merge conflict zones
- LOW: `index.ts` lifecycle handlers; `service.ts` remains the config-hash reconciliation owner.

## Raced background registration replays session state (2026-07-21)

### What changed
- `service.ts` (`#syncFromConfig`): the `registerDirectTools` continuation that
  runs when a raced startup connect finishes in the background now also
  (a) replays `#rehydrateFromSessionHistory` from the stored session context
  and (b) rebuilds the session `<mcp_instructions>` block via
  `refreshMcpInstructionsForSession`. Both were captured once at attach
  completion, which — after PR #260 routed cold lazy servers through the
  bounded startup race — can predate the backgrounded connect, so a resumed
  session lost its restored (tool_search-promoted) tools on the first turn
  and the first turn's system prompt carried no server instructions.
- Tests: `rehydration-wiring.test.ts` awaits the raced registration before
  asserting the first-turn payload; `instructions.test.ts` attaches the
  harness session explicitly and awaits registration; mcp suites broadly
  await raced background completion via new fixture seams
  (`awaitMcpToolRegistration`/`awaitMcpTool` in `fixtures/register-call.ts`,
  `awaitMcpConnected` in `fixtures/service-lifecycle.ts`).

### Why
- The attach-time replay and instructions capture assume the catalog exists
  when attach returns. The startup race deliberately breaks that assumption
  for slow servers; the background continuation must refresh every piece of
  session state derived from the catalog, not just the tool registrations.

### Why extension system couldn't handle this alone
- The continuation lives inside the MCP builtin's startup-race plumbing;
  only the builtin holds the session context, tier-B registration, and the
  instructions module state.

### Expected merge conflict zones
- LOW: `service.ts` `#syncFromConfig` raced-connect options block.

## Non-blocking startup for cold lazy servers + configurable startup window (2026-07-21)

### What changed
- `service.ts` (`#syncFromConfig`): every startup connect now runs through
  `raceMcpStartupConnect` — the branch condition became
  `shouldRaceMcpStartup(lifecycle) || cachedCatalog === undefined`. A cold
  `lazy` server (no cached catalog) previously took a fully-blocking
  `connectAndRefreshMcpCatalog` awaited in `Promise.all(connects)`, so a slow
  or wedged server (e.g. codegraph stuck indexing) gated `attachSession` ->
  `before_agent_start` -> the first turn and the TUI silently swallowed
  prompts. Now the connect is bounded by the startup race and finishes in the
  background; a cached lazy server still needs no startup connect.
- `startup-race.ts`: added `MCP_STARTUP_TIMEOUT_ENV`
  (`SENPI_MCP_STARTUP_TIMEOUT_MS`) and `resolveMcpStartupTimeoutMs`, plus an
  optional `deadlineMs` on `RaceMcpStartupConnectOptions` threaded into
  `waitForMcpStartupRace`. Env override (global) > per-server config > default
  `MCP_STARTUP_RACE_MS` (250); non-numeric/negative env ignored, `0` = never
  wait.
- `config-schema.ts` / `config.ts`: new per-server `startupTimeoutMs` field
  (default 250), sitting beside `connectTimeoutMs`/`requestTimeoutMs`.
- `docs/mcp.md`: documents `startupTimeoutMs` (required by
  `scripts/check-mcp-docs.test.mjs`).

### Why
- A single misbehaving MCP server must never block the agent from starting a
  turn. The eager/keep-alive paths already backgrounded slow connects via the
  250ms startup race; the lazy cold path was the one remaining place that
  blocked. Extending the same race to it closes the "prompt does nothing" bug
  and makes the wait window operator-tunable.

### Why extension system couldn't handle this alone
- The blocking connect lives inside the MCP builtin's session-attach path;
  only the builtin owns per-server lifecycle, the catalog cache, and the
  startup race primitive.

### Expected merge conflict zones
- LOW/MEDIUM: `service.ts` `#syncFromConfig` connect branch; `startup-race.ts`
  option/plumbing; `config-schema.ts`/`config.ts` timeout field lists.


## Trust-aware merge for extension-declared MCP servers (2026-07-17)

### What changed
- `config-schema.ts`: added `"extension"` to the `McpServerSource` union;
  exported `McpServerDeclaration` and `validateMcpServerDeclaration`.
- `config.ts`: added `resolveExtensionMcpServer` (preserves declared
  `exposure`/`directTools`/filters/lifecycle/`enabled`, defaults stdio `cwd` to
  the extension's registration cwd) and `mergeExtensionMcpServers` with
  trust-aware rules: trusted file sources win (including `enabled:false`),
  extension declarations replace `untrusted` placeholders with a diagnostic.

### Why
- The new `pi.registerMcpServer()` extension API needs a merge seam that
  respects the existing trust model: user config must still win, and untrusted
  project placeholders must not block extension-provided defaults.

### Why extension system couldn't handle this alone
- The merge runs inside the MCP builtin but consumes runner-aggregated
  declarations; the builtin cannot know trust rules or normalize server configs.

### Expected merge conflict zones
- MEDIUM: `config.ts` around `resolveSkillMcpServer` and the trusted/untrusted
  merge helpers.

## Attach extension-declared MCP servers on every session attach (2026-07-17)

### What changed
- `service-types.ts`: `McpSessionContext` gained optional
  `getRegisteredMcpServers`; `McpServerSnapshot` gained a `source` field.
- `service-snapshot.ts`: populates `source` from the resolved server.
- `status.ts`: status rows now render `origin=<source>`.
- `service.ts`: `attachSession` calls `mergeExtensionMcpServers` from
  `ctx.getRegisteredMcpServers()` on every invocation, so session start,
  reattach, and `/mcp` command paths all pick up current declarations.
- `docs/mcp.md`: documented the `extension` source and cross-linked to
  `extensions.md`.

### Why
- Declarations are aggregated by the runner, but the MCP builtin must read them
  from the context on every attach to survive reattach and reload without
  caching stale declarations.

### Why extension system couldn't handle this alone
- The runner owns the aggregation and context accessor; the builtin only sees
  the narrow `McpSessionContext` passed into `attachSession`.

### Expected merge conflict zones
- LOW: `service.ts` `attachSession` ordering.
- LOW: `status.ts` row format.

## Overview
Built-in MCP (Model Context Protocol) client support as an in-tree builtin
extension. Fork-native: upstream pi-mono deliberately ships no MCP support, so
every file under `builtin/mcp/` is fork-owned. Uses the exact-pinned official
`@modelcontextprotocol/sdk` and the public `pi.*` extension API only.

## W5 — skills-carry-MCP, proxy, resources, prompts, elicitation, logging (2026-07-08)

### What changed
- New `skills.ts` (todo 37): skills declare MCP servers via an `mcp.json`
  sidecar (wins) or SKILL.md frontmatter `mcp:` block; declared servers resolve
  through `config.ts#resolveSkillMcpServer` (source `"skill"`, forced
  search-mode/no-directTools = 0 pre-load tokens) and register via
  `service.attachSkillMcpServers`; loading a skill (`/skill:` input or the
  model reading its SKILL.md) reveals includeTools glob matches through the new
  `McpTierBRegistration.activate`.
- New `expose/proxy.ts` (todo 38): `exposure:"proxy"` collapses a server to one
  `mcp_<server>` gateway (search/describe/call, JSON-string args) reusing BM25
  and the factored `register.ts#executeMcpCatalogEntry`; policy gains mode
  `"proxy"`; auto never selects it.
- New `resources.ts` (todo 39): `mcp_list_resources`/`mcp_read_resource`
  utility tools (only when resources exist), `@mcp:<server>/<uri>` input-event
  mention expansion, per-resource subscriptions + updated notifications riding
  the tools-changed refresh.
- New `prompts.ts` (todo 40): listed prompts register as `/mcp:<server>:<prompt>`
  commands (ctx.ui argument collection -> prompts/get -> editor injection).
- New `elicitation.ts` (todo 41): EMPTY `{}` capability declared at client
  construction (`transport.ts#buildMcpClient`), flat-primitive form flow over
  ctx.ui, decline without UI / on URL-mode, bounded cancel timeout.
- New `logging.ts` (todo 42): notifications/message -> per-server logger with
  RFC-5424 mapping, `logLevel` filtering, 10/s burst cap.

### Why
- W5 of the MCP plan: capability surface (skills/resources/prompts/elicitation/
  logging) on top of W4's exposure machinery, reusing the activation path,
  guarded call path, and notification refresh loop instead of new plumbing.

### Expected merge conflict zones
- MEDIUM: `expose/session.ts` / `expose/tier-b.ts` (registration input/return
  shapes grew: proxyGateways, utilityTools, McpSessionRegistration).
- LOW: `connection.ts` connect-time subscriptions; `index.ts` event wiring;
  `service.ts` skill/prompt/resource accessors.

## Rehydration wiring + single-flight attach (2026-07-08)

### What changed
- `expose/tier-b.ts`: `registerMcpTierBTools` now returns a
  `McpTierBRegistration` handle (`searchable` + `rehydrateFromHistory`) instead
  of a bare searchable array; the rehydrate closure replays history activation
  markers through the SAME activation path `tool_search` uses (stub swap +
  stable ordering), skipping already-active names.
- `service.ts`: stores the tier-B handle per registration and exposes
  `rehydrateActiveToolsFromHistory(messages)` plus a once-per-registration
  `maybeRehydrateFromHistory` for per-turn context events. Attach now replays
  session history (via the new optional `sessionManager.getEntries` on
  `McpSessionContext`) right after direct-tool registration, so a resumed
  (`--continue`) session's FIRST wire payload already carries previously
  promoted tools — the per-turn context event replay alone landed one turn
  late because the request tool snapshot precedes it.
- `index.ts`: attach is single-flight. `session_start` handlers are dispatched
  fire-and-forget, so a cold server's attach (awaited catalog collection) could
  still be in flight when `before_agent_start` fired; the old `attached`
  boolean then started a SECOND concurrent attach that registered an empty
  catalog for turn 1. `before_agent_start` now awaits the memoized in-flight
  attach promise. Also subscribes `context` as the rehydration safety net.

### Why
- `rehydrateActiveToolsFromHistory` was exported and unit-tested but never
  invoked from the session lifecycle — resumed sessions lost all promotions
  (W4 real-surface QA driver, CLAIM 5). The double-attach race intermittently
  left ALL MCP tools off the wire for the first turns of any cold session
  (CLAIMs 1/3 flaking). Both were invisible to in-process tests and caught
  only by asserting on captured `body.tools` wire payloads.

### Expected merge conflict zones
- MEDIUM: `service.ts` around `attachSession`/`#registerDirectTools` (W5 will
  touch registration for skills-carry-MCP).
- LOW: `expose/tier-b.ts` return-shape consumers; `index.ts` event wiring.

## W4 implementation — Tier-B adaptive tool exposure + local tool-search (2026-07-08)

### What changed
- New `expose/bm25.ts`: zero-dep BM25 (k1=0.9, b=0.4) over tokenised
  name+description with a server-name field boost; normalised exact-name match
  (hyphen/underscore/case-insensitive) short-circuits before BM25; snake/camel/
  kebab tokenizer; deterministic ranking (tie-break by ascending name).
- New `expose/tool-search.ts`: always-active `tool_search` tool that ranks the
  full catalog and promotes matches via `setActiveTools` (union, stable-sorted,
  effective next turn). Results embed a stable `[tool_search:activated]` marker;
  `rehydrateActiveToolsFromHistory` replays activations after compaction/restart,
  restoring only names still in the catalog.
- New `expose/tier-b.ts`: completes `exposure:"auto"`. A server above
  `searchThreshold` enters SEARCH mode — full catalog registered, only
  directTools active, `tool_search` active. Prompt-cache mitigations: stable
  name sort; activation turns accept a cache miss (default mode); opt-in
  `settings.stubSwap` registers 30-70-token stubs so the tools array is
  length-stable and only the promoted entry's bytes change (stub -> full).
- `expose/policy.ts`: `mode` is now `"direct" | "search"`; the W1 `pending-W4`
  register-all-active fallback + warning is removed. `exposure:"search"|"proxy"`
  and threshold-exceeded resolve to search mode.
- `expose/register.ts`: extracted `mapMcpCatalogNames` so the full-tool builder
  and the Tier-B search catalog share one collision-resolved naming source.
- `expose/session.ts`: registration routes through `registerMcpTierBTools`.
- `expose/status.ts`: `/mcp status` reports total exposed tools + a search-mode
  hint (`N active now, M searchable via tool_search`).
- New `expose/native-search.ts` (todo 33, Anthropic half — spike verdict
  GO-pure-extension): `addAnthropicNativeToolSearch` injects the native
  `tool_search_tool_bm25_20251119` tool + per-tool `defer_loading:true` under
  the HARD RULES (never defer the search tool, never defer+cache_control on one
  tool, >=1 non-deferred, <=10k tools), idempotently per rebuilt request;
  `AnthropicNativeToolSearchAdapter` disables native + falls back to local
  tool_search on an injected 400. `index.ts` registers a `before_provider_request`
  (inject) + `after_provider_response` (400 detector) handler pair — a no-op
  unless `settings.nativeToolSearch` is auto|true and the model is
  anthropic-messages. The OpenAI half is deferred (spike = GO-with-ai-seam;
  needs a feat(ai) seam + sign-off — see native-search-spike.md).
- New `notifications.ts` (todo 35): closes the codex list_changed gap.
  `subscribeMcpListChanged` registers tools/resources/prompts list_changed
  handlers on the SDK client regardless of declared capability (gemini
  robustness); `connection.ts` calls it on every successful connect so
  notifications reach `markToolsChanged`. `createMcpListChangeCoalescer`
  collapses a 300ms burst into one refresh under a max-1/s/server burst guard
  (uses `safeTimer`). `service.ts` wires a per-server coalescer to
  `onToolsChanged` and, on refresh, re-lists + re-registers via
  `registerToolsPreservingActiveSet` so ADDED tools enter INACTIVE (rug-pull
  defense) and REMOVED tools are tombstoned (`buildMcpTombstoneDefinition` — a
  stale execute throws "tool no longer available on <server>"); the delta is
  recorded per server for `/mcp status` (`formatMcpListChangedDelta`).

### Why
Large MCP servers (30+ tools) blow the context budget if every tool is resident.
Tier-B keeps inactive tools at ZERO payload contribution (proven by
before_provider_request/context.tools capture: a 30-tool search-mode server
resides in <1k tokens) while `tool_search` gives the model on-demand access. This
is the provider-agnostic P3 path that ships regardless of the native-search
spike outcome (todo 29).

### Why extension system couldn't handle this alone
Nothing in core needed changing: promotion uses the public
`setActiveTools`/`getActiveTools`/`registerTool` surface and the documented
next-turn activation semantics. `registerToolsPreservingActiveSet` counters the
loader's auto-activation of newly registered tools.

### Expected merge conflict zones
- `expose/policy.ts` (MEDIUM): W1 exposure tests updated to the new search-mode
  behaviour; a concurrent policy edit would collide.
- `expose/session.ts` / `expose/register.ts` (LOW): additive routing + one
  extracted helper.
- `expose/status.ts` (LOW): status line format.

## W3 implementation — OAuth 2.1 + token store + bearer/header auth (2026-07-07)

### What changed
- New `builtin/mcp/auth/` subtree implementing spec §7 auth end-to-end:
  - `token-store.ts`: URL-bound credential store at
    `<agentDir>/mcp-auth/<sha256(serverUrl)>/tokens.json` (dir 0700, file 0600),
    atomic tmp+rename writes, cross-process `proper-lockfile` read-modify-write
    (`update`/`withLock`/`writeUnlocked`), `index.json` name→hash map, and
    `clear()`. No keychain (headless-first).
  - `oauth-provider.ts`: SDK `OAuthClientProvider` backed by the store — PKCE
    verifier + client info + tokens persistence, single-use CSRF `state`,
    RFC 8707 `validateResourceURL`, `invalidateCredentials`, token fingerprint
    logging.
  - `oauth-refresh.ts`: preemptive refresh at expiry−5min with in-process
    single-flight + cross-process lock; `assertS256Supported` (typed refusal);
    `invalid_grant`→drop→needs_auth vs transient→bounded-retry distinction.
  - `oauth.ts`: discovery (RFC 9728→8414→OIDC) + S256 pre-flight refusal,
    `beginAuthorization`/`completeAuthorization`/`finishAuthorization`,
    `clientCredentialsGrant`, `logout`.
  - `callback.ts`: lazy 127.0.0.1 loopback listener (OS or fixed port with
    fail-fast on conflict), single-use state, 5-min unref'd timeout,
    `openCallbackChannel` with `oauthCallbackUrl` override → zero listeners.
  - `context.ts`: `resolveAuthMode` (#158 autodetect: headers/explicit disable
    OAuth), `resolveServerAuth` provider factory, `detectLiteralBearerWarnings`.
  - `commands-auth.ts` + `commands-auth-dispatch.ts`: `/mcp auth`,
    `auth-start`, `auth-complete <redirect-url>`, `logout`, client_credentials;
    non-UI callers fail fast with a headless hint (no browser).
  - `oauth-errors.ts`: typed `OAuthFlowError` (terminal vs transient kinds).
- Wired into existing extension files: `transport.ts` (attach `authProvider`
  to the HTTP transport; inject `OAUTH_ACCESS_TOKEN` for stdio OAuth),
  `connection.ts` (map `UnauthorizedError`/terminal `OAuthFlowError` →
  `needs_auth` by unwrapping the wrapped connect cause), `service.ts` +
  `service-types.ts` (build the auth plan per server, store it on the
  connection entry, expose `getAuthTarget`/`getPendingAuth`),
  `connection-types.ts` (`authProvider` option), `commands.ts` (auth
  subcommands).

### Why
- Spec §7 requires OAuth 2.1 (PKCE S256, RFC 8707, discovery, headless flows)
  with a 0600 file token store and a cross-process refresh lock so concurrent
  senpi processes never trigger refresh-token-family invalidation.

### Why extension system couldn't handle this alone
- Not applicable — implemented entirely with the SDK + public `pi.*` API; no
  core-tree edits outside `builtin/mcp/`.

### Expected merge conflict zones
- `builtin/mcp/transport.ts` — LOW (added `authProvider` option + stdio env
  injection; additive).
- `builtin/mcp/connection.ts` / `connection-types.ts` — LOW (added optional
  `authProvider` + a needs_auth branch in the connect catch).
- `builtin/mcp/service.ts` / `service-types.ts` — LOW/MEDIUM (auth-plan
  construction in the connection-creation loop + new accessors).
- `builtin/mcp/commands.ts` — LOW (added auth subcommands to the dispatch).
- `builtin/mcp/changes.md` — LOW (union of entries).

## W1 implementation — config, transports, service, tools, commands (2026-07-07)

### What changed
- Filled the 2026-07-06 no-op skeleton (`extensions/changes.md`) with the full
  W1 implementation across `builtin/mcp/`:
  - `config-schema.ts` / `config.ts` / `config-edit.ts`: TypeBox-validated
    `mcpServers` config with discovery and merge across global, project, and
    imported Claude Desktop configs (`settings.importConfigs: ["claude"]`),
    env-var interpolation, per-server enable/disable, and project-trust gating
    (untrusted projects cannot activate project-scoped servers).
  - `transport.ts`: transport factory for `stdio` (spawned command, default
    environment, spec-conformant shutdown, child process reaping via
    `process-tree.ts`) and `http` (StreamableHTTP client transport).
  - `connection.ts`: per-server connection state machine with connect timeouts
    and async error routing through `wrap.ts` guards.
  - `service.ts`: process-owned singleton service that attaches sessions,
    owns server lifecycle (`lazy` / `eager` / `keep-alive`, idle shutdown),
    surfaces connect failures, and refreshes after extension reloads.
  - `expose/`: tool registration end-to-end with spec-correct call semantics
    (`register.ts`, `naming.ts`, `pagination.ts`, `schema-compat.ts`,
    `session.ts`, `status.ts`) plus the exposure policy (`policy.ts`):
    `auto` / `direct` / `search` / `proxy`, `includeTools` / `excludeTools`
    filtering, `directTools`, and the `searchThreshold` cutoff. Inactive tools
    are cleared after policy filtering.
  - `commands.ts` / `status.ts`: the `/mcp` command suite — `status`, `add`,
    `enable` / `disable`, `test`, `logs`, `reconnect` — with tool refresh after
    `add`.
  - `instructions.ts`: MCP server `instructions` are injected into the system
    prompt through `before_agent_start` and refreshed on session start.
  - `log.ts` / `errors.ts` / `wrap.ts`: per-server logging with secret
    redaction (authorization headers, error payloads, wrap fallbacks), an MCP
    error taxonomy, and async wrap utilities so background failures surface
    without leaking secrets.
  - `catalog.ts` / `active-set.ts`: resolved-server catalog and active tool
    set bookkeeping.
- `builtin/index.ts`: the `mcp` entry registered by the skeleton is unchanged
  (kept last so its provider-payload tap observes all co-resident builtin
  mutations).
- Auth: `bearer` (via `bearerTokenEnv`) and `oauth` (authorization-code and
  client-credentials flows, optional `clientMetadataUrl` / `scopes` /
  `oauthCallbackUrl`) per server.

### Senpi design decisions
- MCP is a builtin extension, not core: pi philosophy keeps MCP out of the
  core runtime, and the fork honors that boundary — everything reaches the
  session through `registerTool`, `registerCommand`, and event handlers.
- The service is process-owned (not session-owned) so keep-alive servers and
  their child processes survive session reloads and are reaped exactly once.
- Output guards (`settings.outputGuard`: `maxBytes` / `maxLines` /
  `maxTokens`) bound tool results before they reach the model context.
- Search-based exposure exists to keep large MCP catalogs from flooding the
  tool list; `settings.nativeToolSearch` can defer to provider-native tool
  search where available.

### Why extension system couldn't handle this differently
- Implemented entirely as a builtin extension via the public `pi.*` API
  (`registerTool`, `registerCommand`, `session_start`, `before_agent_start`,
  `session_shutdown`). No change to `extensions/types.ts` or `runner.ts`.

### Expected merge conflict zones on next upstream sync
- LOW: `builtin/index.ts` import block + `builtinExtensions` array if upstream
  reorders or adds builtins.
- LOW: `packages/coding-agent/package.json` around the exact-pinned
  `@modelcontextprotocol/sdk` dependency.
- NONE for `extensions/types.ts` (untouched); `builtin/mcp/` itself does not
  exist upstream.

## Non-blocking reconnect on hot reload (2026-08-20)

### What changed

- The `session_start` handler still starts `attach()` immediately, but when `event.reason === "reload"` it no longer awaits it; errors keep flowing through `wrapAsync` -> the extension error sink. `startup`/omitted reasons await exactly as before.

### Why

- Hot reload awaits every `session_start` handler; MCP reconnect measured ~260ms per reload on the critical path. Attach is single-flight (`attachPromise` + `McpService` attach queue) and `before_agent_start` already awaits `attachPromise`, so tools are still connected before any agent turn needs them.

### Why an extension could not handle it

- The handler lives in this builtin; only it can decide not to await its own reconnect.

### Expected merge conflict zones

- LOW: `index.ts` `session_start` registration block; new `test/suite/mcp-reload-deferral.test.ts`.


## 2026-10-02 - Claim legacy MCP credentials under a shared migration lock

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/auth/token-store.ts`

`read()` migrated a URL-keyed legacy record (read/copy/delete) without a lock, so two processes could both read it before either removed it and persist the same rotating grant under two different server-name keys. The claim is now serialized on a lock file created with O_EXCL and keyed on the legacy hash (shared by every consumer of that URL), with the legacy record and the destination both re-checked under the lock before writing.

### Why

Duplicating a single-use refresh-token family across identities defeats the new per-server account isolation and can invalidate the grant on the next refresh. The per-server update locks are keyed by destination and cannot serialize this migration.

### Why an extension could not handle it

The token store is the fork's credential-persistence layer; no extension hook sits between read() and the on-disk legacy record.

### Expected merge conflict zones

Upstream edits to `token-store.ts` legacy migration at the next sync.


## 2026-10-08 - Bind stored OAuth credentials to their authorization server; legible cross-origin redirect refusal (senpi#2940)

### What changed

- `packages/coding-agent/package.json`: `@modelcontextprotocol/sdk` 1.30.0 -> 1.32.1 (GHSA-6qxp-vccf-f47h: the OAuth client could send credentials to an authorization server chosen by the MCP server). `proxy-addr` resolves 2.0.8 (GHSA-jqcg-44mw-7w3h) in the lockfiles.
- `auth/token-store.ts`, `auth/oauth-provider.ts`: `McpStoredAuth.issuer` records the authorization server that issued the tokens. `mergeTokensIntoStoredAuth` keeps the SDK's `issuer` stamp (it was dropped before, so the SDK's binding never applied to refresh tokens), and `storedAuthToTokens` hands it back. `storedGrantIssuer` falls back to the sign-in's `discoveryState.authorizationServerUrl` for a record saved before the stamp existed; a record with neither cannot be attributed, and its refresh token is withheld.
- `auth/oauth-refresh.ts`: `McpRefreshManager` refreshes only at the authorization server that issued the grant. An unattributed grant or one bound to a different authorization server is a continuity break: the credentials are cleared and `needs_auth` asks for a fresh sign-in, naming both servers.
- `auth/oauth.ts`: client-credentials tokens are stamped with the discovered authorization server.
- `transport.ts`: the SDK (1.32+) follows HTTP redirects only within the endpoint's origin; senpi keeps that default. A connect that fails on a cross-origin redirect now names the endpoint origin, the redirect origin, the same-origin rule and the URL to configure.

### Why

A refresh token is a long-lived credential; presenting it to an authorization server other than its issuer leaks it. The SDK fixed this by stamping what it saves, which only works if the provider persists the stamp.

### Why an extension could not handle it

The token store and refresh manager are this builtin's credential layer.

### Expected merge conflict zones

`auth/oauth-provider.ts` token mapping and `auth/oauth-refresh.ts` `#doRefresh` at the next SDK or upstream sync.

## 2026-10-22 - A connect or reconnect superseded by dispose or renew is not a server failure (senpi#4013)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/connection.ts`: `#markFailure` is a no-op once the connection is `disabled`, so `markDegraded`/`markSuspended`/`markNeedsAuth`/`markNeedsClientRegistration` from an attempt that dispose/disable superseded can no longer revive a disposed connection (which re-enabled `connect()`/`renew()`).
- `packages/coding-agent/src/core/extensions/builtin/mcp/shared-lease.ts`: a released lease's `mark*` methods no longer reach the shared connection the surviving owners still use.
- `packages/coding-agent/src/core/extensions/builtin/mcp/startup-race.ts`: `connectMcpServer` returns without degrading or logging when the connection is `disabled` or its generation moved (a renew superseded the attempt); the startup `ensureFresh` catch returns silently once the connection is `disabled`.
- `packages/coding-agent/src/core/extensions/builtin/mcp/service-connection.ts`: the reconnect callback's `ensureFresh` catch returns silently once the connection is `disabled`.

### Why

- `dispose()` aborts an in-flight attempt by shutting its transport down, but `shutdownMcpTransport` waits at most `SHUTDOWN_CLOSE_WAIT_MS` for the close; under Bun the close, and so the attempt's rejection, can land after `dispose()` returned. The late `connect was superseded` was then treated as a server failure: the disposed connection flipped to `degraded`, and a warning was written to a server log whose path is fixed at logger construction, recreating a removed agent dir. A reconnect in flight at dispose, a renew that superseded a startup connect, and a late OAuth refresh failure did the same.

### Why an extension could not handle it

- These are the MCP builtin's own connection state machine and its attach/reconnect paths; no extension hook observes or owns them.

### Expected merge conflict zones

- `connection.ts` `#markFailure`; `shared-lease.ts` `mark*` overrides; `startup-race.ts` `connectMcpServer` and the `refreshConnectedMcpCatalog` auth catch; `service-connection.ts` reconnect callback auth catch.

## 2026-10-22 - whenAttachSettled observes an attach that is still running (senpi#4027)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/mcp/service.ts`: `whenAttachSettled` first awaits the attach queue (every attach and re-sync joins it synchronously via `#queueSync`), bounded by the same timeout, and then the backgrounded connects in `#deferredAttach` with the remaining budget.

### Why

- An attach hands its backgrounded startup connects to `#deferredAttach` only after each startup race's 0 ms timer, near the end of the attach sync. A `whenAttachSettled` call that landed while the attach was still running read an empty pending set and reported `settled`, so a caller assembling the first turn (or a test observing the attach) saw MCP tools as attached when they were not.

### Why an extension could not handle it

- The attach queue and the deferred-connect set are private to the MCP service; no extension hook can observe an attach in flight.

### Expected merge conflict zones

- `service.ts` `whenAttachSettled` and its doc comment; the `./startup-race.ts` import list (`waitForMcpStartupRace`).

## 2026-10-17 - Never hold the legacy migration lock across an await (senpi#3546)

### What changed

- `auth/legacy-lock.ts`: `withLegacyLock(path, stale, critical)` replaces `acquireLegacyLock`. Waiting for another holder stays asynchronous, but taking the lock, running the claim and releasing it now happen in one synchronous step.
- `auth/legacy-migration.ts`: `readRecordAsync` and the synchronous `adoptLegacyRecord` return "no grant" without taking the lock when there is no legacy URL-keyed grant to claim. A lock-acquisition failure still surfaces as `LockAcquireError`; an error from the claim itself propagates unchanged.

### Why

Every MCP HTTP request looks up its token synchronously (`tokens()` in `modern/http-fetch.ts` and `transport-sdk.ts`). For a server with no saved grant that lookup took the migration lock with the event loop blocked. When the holder was the asynchronous lookup of the same process (OAuth preparation before each catalog refresh), the holder could never run its release, so the whole process froze until the lock went stale (30 s). Tool calls then failed with "MCP metadata was not ready before the request timeout", which is the intermittent failure in `test/mcp/session-expiry-full-reconnect.test.ts`.

### Why an extension could not handle it

The token store and its legacy migration are this builtin's credential layer.

### Expected merge conflict zones

`auth/legacy-migration.ts` `readRecordAsync` and `adoptLegacyRecord` at the next upstream or SDK sync.
