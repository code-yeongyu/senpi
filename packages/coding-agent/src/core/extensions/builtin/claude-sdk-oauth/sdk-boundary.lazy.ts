/**
 * Lazy boundary for the Claude Agent SDK runtime module.
 *
 * `@anthropic-ai/claude-agent-sdk`'s entrypoint is a ~1.2 MB single-file
 * bundle that every CLI start parses and evaluates today, even though only the
 * claude-sdk-oauth streaming lane ever calls into it. This module owns the one
 * deferred import; `sdk-boundary.ts` keeps the synchronous `getSdkBoundary()`
 * surface its callers depend on and simply refuses to hand out SDK functions
 * before {@link loadClaudeAgentSdk} has resolved.
 *
 * That split is what keeps the deferral honest: the SDK's `query` and
 * `createSdkMcpServer` are synchronous, so their call sites cannot await. Every
 * one of them is reached from an async entry point that awaits this loader
 * first (the `streamClaudeSdkOauth` async body, `reattachSession`,
 * `verifyRestoredTranscript`), so the module is always resident by the time a
 * synchronous member is read — and a future call site that forgets to preload
 * fails loudly and locally instead of silently regressing startup.
 *
 * Follows the repository's documented lazy-boundary pattern
 * (`packages/ai/src/api/*.lazy.ts`); `test/startup-import-graph.test.ts` fails
 * if a static edge to the SDK reappears.
 */
import type { createSdkMcpServer, getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeAgentSdkModule = {
	query: typeof query;
	createSdkMcpServer: typeof createSdkMcpServer;
	getSessionMessages: typeof getSessionMessages;
};

let loaded: ClaudeAgentSdkModule | undefined;
let loading: Promise<ClaudeAgentSdkModule> | undefined;

/**
 * Loads the SDK once and caches it. Concurrent callers share the in-flight
 * promise; a failed load is not cached, so a later attempt can retry.
 */
export function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
	if (loaded) return Promise.resolve(loaded);
	loading ??= import("@anthropic-ai/claude-agent-sdk")
		.then((module) => {
			loaded = {
				query: module.query,
				createSdkMcpServer: module.createSdkMcpServer,
				getSessionMessages: module.getSessionMessages,
			};
			return loaded;
		})
		.finally(() => {
			loading = undefined;
		});
	return loading;
}

/**
 * The loaded SDK, or `undefined` when nothing has awaited
 * {@link loadClaudeAgentSdk} yet.
 */
export function loadedClaudeAgentSdk(): ClaudeAgentSdkModule | undefined {
	return loaded;
}
