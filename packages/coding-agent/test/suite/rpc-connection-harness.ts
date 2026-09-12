import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { createTestResourceLoader } from "../utilities.ts";

export class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

export function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export interface Harness {
	runtimeHost: AgentSessionRuntime;
	authStorage: AuthStorage;
	authPath: string;
	cleanup: () => void;
}

export function makeHarness(tempDir: string): Harness {
	const model = getModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("model not found");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: assistantMessage("") });
				stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
			});
			return stream;
		},
	});
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authPath = join(tempDir, "auth.json");
	const authStorage = AuthStorage.create(authPath);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
	return { runtimeHost, authStorage, authPath, cleanup: () => session.dispose() };
}

export type RpcRecord = Record<string, unknown>;

export interface CollectedSink {
	sink: RpcConnectionSink;
	messages: () => readonly RpcRecord[];
	waitFor: (predicate: (message: RpcRecord) => boolean, timeoutMs?: number) => Promise<RpcRecord>;
}

/** Collect complete JSONL records and await the exact record under test. */
export function makeSink(): CollectedSink {
	const records: RpcRecord[] = [];
	const waiters: Array<{ predicate: (message: RpcRecord) => boolean; resolve: (message: RpcRecord) => void }> = [];
	let buffer = "";

	const dispatch = (record: RpcRecord) => {
		records.push(record);
		for (let index = 0; index < waiters.length; index++) {
			const waiter = waiters[index];
			if (waiter.predicate(record)) {
				waiters.splice(index, 1);
				waiter.resolve(record);
				break;
			}
		}
	};

	return {
		sink: {
			writeRaw(chunk) {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line) dispatch(JSON.parse(line) as RpcRecord);
					newline = buffer.indexOf("\n");
				}
			},
			waitForBackpressure: async () => {},
		},
		messages: () => records,
		waitFor(predicate, timeoutMs = 1_000) {
			const existing = records.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
					if (index !== -1) waiters.splice(index, 1);
					reject(new Error("Timed out waiting for the expected RPC record"));
				}, timeoutMs);
				waiters.push({
					predicate,
					resolve: (message) => {
						clearTimeout(timeout);
						resolve(message);
					},
				});
			});
		},
	};
}
