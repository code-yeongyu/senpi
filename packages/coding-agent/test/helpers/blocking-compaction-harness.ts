import { fauxAssistantMessage, registerFauxProvider, type UserMessage } from "@earendil-works/pi-ai";
import { expect, vi } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	ModelSelectEvent,
	ModelSelectEventResult,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "./extension-session-settings.ts";

export interface CompactionHandlers {
	beforeAgentStart: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
	modelSelect: ExtensionHandler<ModelSelectEvent, ModelSelectEventResult>;
	sessionBeforeCompact: NonNullable<ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>>;
}

export function createCompactionHandlers(): CompactionHandlers {
	let beforeAgentStart: CompactionHandlers["beforeAgentStart"] | undefined;
	let modelSelect: CompactionHandlers["modelSelect"] | undefined;
	let sessionBeforeCompact: CompactionHandlers["sessionBeforeCompact"] | undefined;
	const api = {
		events: {
			emit: () => undefined,
		},
		on: (event: string, handler: unknown) => {
			if (event === "before_agent_start") {
				beforeAgentStart = handler as CompactionHandlers["beforeAgentStart"];
			}
			if (event === "model_select") {
				modelSelect = handler as CompactionHandlers["modelSelect"];
			}
			if (event === "session_before_compact") {
				sessionBeforeCompact = handler as CompactionHandlers["sessionBeforeCompact"];
			}
		},
	} as unknown as ExtensionAPI;
	compactionExtension(api);
	expect(beforeAgentStart).toBeDefined();
	expect(modelSelect).toBeDefined();
	expect(sessionBeforeCompact).toBeDefined();
	return {
		beforeAgentStart: beforeAgentStart as CompactionHandlers["beforeAgentStart"],
		modelSelect: modelSelect as CompactionHandlers["modelSelect"],
		sessionBeforeCompact: sessionBeforeCompact as CompactionHandlers["sessionBeforeCompact"],
	};
}

export interface BlockingHarness {
	ctx: ExtensionContext;
	sessionManager: SessionManager;
	endCompaction: ReturnType<typeof vi.fn>;
	getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
	registration: ReturnType<typeof registerFauxProvider>;
	setUsageTokens: (tokens: number) => void;
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function createBlockingContext(options: {
	usageTokens: number;
	withAuth?: boolean;
	beginCompaction?: () => AbortSignal | undefined;
}): BlockingHarness {
	const registration = registerFauxProvider();
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(userMessage("Summarize old context", 1));
	sessionManager.appendMessage({
		...fauxAssistantMessage("Old assistant context ".repeat(6_000), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 30_000,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	sessionManager.appendMessage(userMessage("Keep latest request", 3));
	const modelRegistry = Object.create(null) as ExtensionContext["modelRegistry"];
	const getApiKeyAndHeaders = vi.fn(
		options.withAuth === false
			? async () => ({ ok: false as const, error: "no API key configured" })
			: async () => ({ ok: true as const, apiKey: "test-key" }),
	);
	modelRegistry.getApiKeyAndHeaders = getApiKeyAndHeaders as ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"];
	const endCompaction = vi.fn();
	let usageTokens = options.usageTokens;
	const ctx = {
		hasUI: false,
		mode: "print",
		ui: Object.create(null) as ExtensionContext["ui"],
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		sessionManager,
		modelRegistry,
		model,
		serviceTier: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => ({
			tokens: usageTokens,
			contextWindow: 10_000,
			percent: (usageTokens / 10_000) * 100,
		}),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 2_000 }),
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		compact: vi.fn(),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
		beginCompaction: options.beginCompaction ?? (() => undefined),
		endCompaction,
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	return {
		ctx,
		sessionManager,
		endCompaction,
		getApiKeyAndHeaders,
		registration,
		setUsageTokens: (tokens: number) => {
			usageTokens = tokens;
		},
	};
}

export function createBeforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "continue",
		systemPrompt: "system",
		systemPromptOptions: Object.create(null) as BeforeAgentStartEvent["systemPromptOptions"],
	};
}

export function connectionErrorResponse() {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." });
}
