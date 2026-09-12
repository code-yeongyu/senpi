import type {
	EffortLevel,
	Options,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
	SettingSource,
	ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { loadClaudeAgentSdk, loadedClaudeAgentSdk } from "./sdk-boundary.lazy.ts";

export { loadClaudeAgentSdk } from "./sdk-boundary.lazy.ts";
export type {
	Base64ImageSource,
	ContentBlockParam,
	EffortLevel,
	Options,
	SDKMessage,
	SDKUserMessage,
	SessionMessage,
	SettingSource,
	ThinkingConfig,
};

type SdkModule = Awaited<ReturnType<typeof loadClaudeAgentSdk>>;

export type SdkQueryInput = Parameters<SdkModule["query"]>[0];
export type SdkQueryHandle = AsyncIterable<SDKMessage> & {
	interrupt(): Promise<unknown>;
	setModel?: (model?: string) => Promise<void>;
	close(): void;
	initializationResult?: () => Promise<unknown>;
};
export type SdkQuery = (input: SdkQueryInput) => SdkQueryHandle;

export type SdkBoundary = {
	query: SdkQuery;
	createSdkMcpServer: SdkModule["createSdkMcpServer"];
	getSessionMessages: SdkModule["getSessionMessages"];
};

/**
 * Reads the deferred SDK module for a synchronous boundary member.
 *
 * `query` and `createSdkMcpServer` are synchronous SDK functions, so the
 * default boundary cannot await here. Every caller reaches these through an
 * async entry point that awaits `loadClaudeAgentSdk()` first, which makes an
 * unloaded module a wiring defect rather than a runtime condition — and this
 * names it at the exact call that skipped the preload.
 */
function requireLoadedSdk(member: keyof SdkBoundary): SdkModule {
	const sdk = loadedClaudeAgentSdk();
	if (!sdk) {
		throw new Error(
			`Claude Agent SDK was not preloaded before '${member}'. ` +
				`Await loadClaudeAgentSdk() on the entry path before reaching the SDK boundary.`,
		);
	}
	return sdk;
}

const defaultSdkBoundary: SdkBoundary = {
	query: (input) => requireLoadedSdk("query").query(input),
	createSdkMcpServer: (options) => requireLoadedSdk("createSdkMcpServer").createSdkMcpServer(options),
	getSessionMessages: async (sessionId, options) =>
		(await loadClaudeAgentSdk()).getSessionMessages(sessionId, options),
};
let activeSdkBoundary = defaultSdkBoundary;

export function getSdkBoundary(): SdkBoundary {
	return activeSdkBoundary;
}

export function overrideSdkBoundary(override: Partial<SdkBoundary>): void {
	activeSdkBoundary = { ...defaultSdkBoundary, ...override };
}

export function resetSdkBoundary(): void {
	activeSdkBoundary = defaultSdkBoundary;
}

export default defaultSdkBoundary;
