import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/index.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../../../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../../../src/core/extensions/types.ts";
import type { CompactionEntry } from "../../../src/core/session-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createInMemoryExtensionSessionSettings } from "../../helpers/extension-session-settings.ts";
import { createModelRegistry } from "../../model-runtime-test-utils.ts";

const CONTEXT_WINDOW = 1_000_000;
const INCIDENT_DERIVED_TOOL_RESULT_VOLUME = 1_510;
const RESULT_BODY_BYTES = 800;

interface UsageState {
	tokens: number;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: `probe-${id}` } }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: `result-${id}-${"x".repeat(RESULT_BODY_BYTES)}` }],
		isError: false,
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function payloadScaleHistory(): AgentMessage[] {
	const messages: AgentMessage[] = [userMessage("sanitized payload-scale fixture", 1)];
	for (let index = 0; index < INCIDENT_DERIVED_TOOL_RESULT_VOLUME; index += 1) {
		const id = `call-${index}`;
		messages.push(assistantToolCall(id, index * 2 + 2), toolResult(id, index * 2 + 3));
	}
	return [...messages, userMessage("latest request", INCIDENT_DERIVED_TOOL_RESULT_VOLUME * 2 + 2)];
}

function payloadHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function createRunner(usageState: UsageState): Promise<ExtensionRunner> {
	const extensionActions: ExtensionActions = {
		registerLazyToolActivator: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		executeTool: async () => {
			throw new Error("Tool execution is not available in this lifecycle harness");
		},
		getActiveTools: () => ["read", "write"],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		registerRemovedToolHint: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "high",
		setThinkingLevel: () => {},
		setSessionModel: async () => false,
		setSessionThinkingLevel: () => {},
		setSessionFastMode: () => {},
	};
	const cwd = process.cwd();
	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		getServiceTier: () => undefined,
		getScopedModels: () => [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		isCompacting: () => false,
		shutdown: () => {},
		getContextUsage: () => ({
			tokens: usageState.tokens,
			contextWindow: CONTEXT_WINDOW,
			percent: usageState.tokens / CONTEXT_WINDOW,
		}),
		compact: () => {},
		getMessageRevision: () => 1,
		applyCompaction: async () => ({ applied: false, reason: "rejected" }),
		getCompactionSettings: () => DEFAULT_COMPACTION_SETTINGS,
		getLookAtSettings: () => ({ enabled: true, models: undefined }),
		getImageSettings: () => ({ autoResize: true, blockImages: false }),
		sessionSettings: createInMemoryExtensionSessionSettings(),
		getSystemPrompt: () => "",
		getLoadedHookSources: () => ({
			agentDir: cwd,
			cwd,
			globalHookSourcePaths: [],
			globalHooksPath: `${cwd}/hooks.json`,
			preSessionHookSourcePaths: [],
			projectHookSourcePaths: [],
			projectHooksPath: `${cwd}/.senpi/hooks.json`,
			runtimeHookSourcePaths: [],
		}),
	};
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		compactionExtension,
		cwd,
		createEventBus(),
		runtime,
		"<builtin:compaction>",
	);
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		cwd,
		SessionManager.inMemory(cwd),
		await createModelRegistry(AuthStorage.inMemory()),
	);
	runner.bindCore(extensionActions, contextActions);
	return runner;
}

function acceptedCompactionEntry(): CompactionEntry {
	return {
		type: "compaction",
		id: "accepted-compaction",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		summary: "sanitized compacted context",
		firstKeptEntryId: "none",
		tokensBefore: 501_000,
	};
}

async function contextHash(runner: ExtensionRunner, messages: AgentMessage[]): Promise<string> {
	return payloadHash(await runner.emitContext(messages));
}

describe("request-local context reduction extension lifecycle", () => {
	it("holds a payload-scale reduction through rejection and resets only after accepted compaction", async () => {
		const messages = payloadScaleHistory();
		const serializedBytes = Buffer.byteLength(JSON.stringify(messages));
		const toolResultCount = messages.filter((message) => message.role === "toolResult").length;
		expect(toolResultCount).toBe(INCIDENT_DERIVED_TOOL_RESULT_VOLUME);
		expect(serializedBytes).toBeGreaterThan(1_000_000);

		const usageState = { tokens: 501_000 };
		const runner = await createRunner(usageState);
		const reducedHash = await contextHash(runner, messages);

		usageState.tokens = 499_000;
		expect(await contextHash(runner, messages)).toBe(reducedHash);

		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "rejected-request",
			accepted: false,
			rejectionCause: "cancelled-by-extension",
			fromExtension: false,
			willRetry: false,
		});
		expect(await contextHash(runner, messages)).toBe(reducedHash);

		await runner.emit({
			type: "session_compact",
			reason: "manual",
			requestId: "accepted-request",
			accepted: true,
			compactionEntry: acceptedCompactionEntry(),
			fromExtension: true,
			willRetry: false,
		});
		expect(await contextHash(runner, messages)).not.toBe(reducedHash);
	});
});
