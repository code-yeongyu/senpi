import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

export const providerEnvelope = JSON.stringify({
	type: "error",
	error: { type: "api_error", message: "Network error or service unavailable" },
});

export function assistantFailure(errorMessage = providerEnvelope): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		stopReason: "error",
		errorMessage,
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

export function createPresentationHarness() {
	initTheme("dark");
	const chat = new Container();
	const status = new Container();
	const mode: InteractiveMode = Object.create(InteractiveMode.prototype);
	const session = { retryAttempt: 0, currentAbortSource: undefined, isStreaming: false };
	Object.defineProperties(mode, {
		session: { value: session },
		sessionManager: { value: { getEntryCount: () => 0 } },
		settingsManager: {
			value: {
				getShowTerminalProgress: () => false,
				getShowCacheMissNotices: () => false,
				getSmoothStreaming: () => false,
			},
		},
	});
	Object.assign(mode, {
		isInitialized: true,
		chatContainer: chat,
		statusContainer: status,
		loadedResourcesContainer: new Container(),
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		defaultEditor: {},
		editor: { setText: vi.fn(), getText: () => "" },
		pendingTools: new Map(),
		assistantTextSegments: new Map(),
		pendingUserInputs: [],
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		outputPad: 1,
		hiddenThinkingLabel: "Thinking",
		streamingReveal: { begin: vi.fn(), stop: vi.fn(), setTarget: vi.fn(), isPacingHead: () => false },
		toolArgsReveal: { flushAll: vi.fn(), stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		turnWorkingTip: { resetForNewTurn: vi.fn() },
		optimisticUserEchoes: { replaceNext: () => false },
		getMarkdownTransformers: () => [],
		getMarkdownThemeWithSettings: () => undefined,
		requestStreamingRender: vi.fn(),
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		clearPendingTools: () => {},
		addContinuityNotice: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		checkShutdownRequested: vi.fn(),
		restoreQueuedMessagesToEditor: () => 0,
		showStatusIndicator(indicator: Component & { dispose(): void }) {
			Reflect.get(mode, "activeStatusIndicator")?.dispose();
			Reflect.set(mode, "activeStatusIndicator", indicator);
			status.clear();
			status.addChild(indicator);
		},
		clearStatusIndicator(kind?: string) {
			const active = Reflect.get(mode, "activeStatusIndicator");
			if (kind && active?.kind !== kind) return;
			active?.dispose();
			Reflect.set(mode, "activeStatusIndicator", undefined);
			status.clear();
		},
	});
	return {
		mode,
		chat,
		status,
		session,
		async event(event: AgentSessionEvent): Promise<void> {
			await Reflect.get(InteractiveMode.prototype, "handleEvent").call(mode, event);
		},
		render(width = 100): string {
			return [...chat.render(width), ...status.render(width)].join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		},
		expand(expanded = true): void {
			for (const child of chat.children) {
				if ("setExpanded" in child && typeof child.setExpanded === "function") child.setExpanded(expanded);
			}
		},
		dispose(): void {
			Reflect.get(mode, "activeStatusIndicator")?.dispose();
		},
	};
}
