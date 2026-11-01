/**
 * S06: the host-independent loop boundary, relative to packages/agent/src.
 * Every local dependency (including type imports) must also be listed and checked.
 * Host adapters, carriers, persistence implementations and the Node harness stay outside.
 * Extend this closure when adding loop modules; never add a host implementation to it.
 */
export const LOOP_CORE_MODULES = [
	"agent.ts",
	"agent-loop.ts",
	"assistant-terminal-state.ts",
	"empty-assistant-recovery.ts",
	"internal-events.ts",
	"local-failure.ts",
	"response-timing.ts",
	"stream-fn.ts",
	"stream-keepalive.ts",
	"tool-arguments.ts",
	"tool-name-alias.ts",
	"types.ts",
	"durable/store.ts",
	"execution/tool-host.ts",
	"durable/store-admission.ts",
	"durable/wake-host.ts",
	"transport/transport.ts",
] as const;

/**
 * Existing portable model/message utilities and schema types, not provider runtimes.
 * Exact specifiers deliberately exclude compat, OAuth, SDKs and host-specific subpaths.
 * The model implementation enters the loop through StreamFn, not a provider import.
 */
export const LOOP_CORE_EXTERNAL_MODULES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/utils/oauth-refresh-error",
	"@earendil-works/pi-ai/utils/retry",
	"@earendil-works/pi-ai/utils/tool-name-match",
	"typebox",
] as const;
