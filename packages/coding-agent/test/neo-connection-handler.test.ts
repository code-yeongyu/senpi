/**
 * connection-handler.ts: the per-connection RPC core extracted from runRpcMode.
 *
 * Proves the handler writes to its INJECTED sink (never process.stdout) and
 * registers no process-level signal handlers — the properties that let it serve
 * one socket connection in the daemon. It is driven with a faux-stream runtime
 * exactly like rpc-prompt-response-semantics.test.ts drives runRpcMode.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../src/modes/rpc/connection-handler.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

function assistantMessage(text: string): AssistantMessage {
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

function makeRuntimeHost(tempDir: string): { runtimeHost: AgentSessionRuntime; cleanup: () => void } {
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
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
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
	return { runtimeHost, cleanup: () => session.dispose() };
}

describe("createRpcConnectionHandler", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `neo-conn-handler-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes responses to the injected sink, not process.stdout", async () => {
		const lines: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		};
		const host = makeRuntimeHost(tempDir);
		cleanup = host.cleanup;

		const stdoutSpy = vi.spyOn(process.stdout, "write");
		const handler = createRpcConnectionHandler(host.runtimeHost, sink);
		await handler.handleInputLine(JSON.stringify({ id: "s1", type: "get_state" }));

		const parsed = lines
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const stateResponse = parsed.find((m) => m.id === "s1" && m.command === "get_state");
		expect(stateResponse).toMatchObject({ type: "response", success: true });
		// The handler must never write to the process stdout stream directly.
		expect(stdoutSpy).not.toHaveBeenCalled();
		stdoutSpy.mockRestore();
		await handler.dispose();
	});

	it("registers no process signal handlers", async () => {
		const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
		const host = makeRuntimeHost(tempDir);
		cleanup = host.cleanup;
		const handler = createRpcConnectionHandler(host.runtimeHost, {
			writeRaw: () => {},
			waitForBackpressure: async () => {},
		});
		await handler.handleInputLine(JSON.stringify({ id: "s2", type: "get_state" }));
		const after = process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
		expect(after).toBe(before);
		await handler.dispose();
	});

	it("reports an unknown command as a typed error response", async () => {
		const lines: string[] = [];
		const host = makeRuntimeHost(tempDir);
		cleanup = host.cleanup;
		const handler = createRpcConnectionHandler(host.runtimeHost, {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		});
		await handler.handleInputLine(JSON.stringify({ id: "u1", type: "no_such_command" }));
		const parsed = lines
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		expect(parsed.find((m) => m.id === "u1")).toMatchObject({
			success: false,
			error: expect.stringContaining("Unknown command"),
		});
		await handler.dispose();
	});
});
