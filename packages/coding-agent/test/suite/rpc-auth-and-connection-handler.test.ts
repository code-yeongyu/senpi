import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../src/modes/rpc/connection-handler.ts";
import { createTestResourceLoader } from "../utilities.ts";

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

interface Harness {
	runtimeHost: AgentSessionRuntime;
	authStorage: AuthStorage;
	authPath: string;
	cleanup: () => void;
}

function makeHarness(tempDir: string): Harness {
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

type RpcRecord = Record<string, unknown>;

interface CollectedSink {
	sink: RpcConnectionSink;
	messages: () => readonly RpcRecord[];
	waitFor: (predicate: (message: RpcRecord) => boolean, timeoutMs?: number) => Promise<RpcRecord>;
}

/** Collect complete JSONL records and await the exact record under test. */
function makeSink(): CollectedSink {
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

describe("RPC auth and connection handler contracts", () => {
	let tempDir: string;
	let cleanup: () => void = () => {};

	beforeEach(() => {
		tempDir = join(tmpdir(), `rpc-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		cleanup();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists authentication providers with their status", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "providers", type: "get_auth_providers" }));
		const response = await collected.waitFor((message) => message.id === "providers");
		expect(response).toMatchObject({ type: "response", command: "get_auth_providers", success: true });
		const data = response.data as { providers: Array<Record<string, unknown>> };
		const anthropic = data.providers.find((provider) => provider.id === "anthropic");
		expect(anthropic).toMatchObject({ authType: "oauth", name: expect.any(String) });
		expect(anthropic?.status).toMatchObject({ configured: expect.any(Boolean) });
		await handler.dispose();
	});

	it("frames login start, URL, and completion as distinct JSONL records", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const loginSpy = vi.spyOn(harness.authStorage, "login").mockImplementation(async (providerId, callbacks) => {
			callbacks.onAuth({ url: "https://stub.example/oauth?code=FAKE" });
			harness.authStorage.set(providerId, {
				type: "oauth",
				access: "FAKE-ACCESS",
				refresh: "FAKE-REFRESH",
				expires: Date.now() + 3_600_000,
			});
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const url = collected.waitFor((message) => message.type === "auth_login_url");
		const end = collected.waitFor((message) => message.type === "auth_login_end");

		await handler.handleInputLine(JSON.stringify({ id: "login", type: "login_start", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "login")).toMatchObject({
			type: "response",
			command: "login_start",
			success: true,
		});
		expect(await url).toMatchObject({ provider: "anthropic", url: "https://stub.example/oauth?code=FAKE" });
		expect(await end).toMatchObject({ provider: "anthropic", success: true });
		expect(loginSpy).toHaveBeenCalledWith("anthropic", expect.anything());
		await handler.dispose();
	});

	it("frames login failures as a terminal auth event", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		vi.spyOn(harness.authStorage, "login").mockRejectedValue(new Error("oauth port busy"));
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const end = collected.waitFor((message) => message.type === "auth_login_end");

		await handler.handleInputLine(JSON.stringify({ id: "failed-login", type: "login_start", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "failed-login")).toMatchObject({ success: true });
		expect(await end).toMatchObject({
			provider: "anthropic",
			success: false,
			error: expect.stringContaining("oauth port busy"),
		});
		await handler.dispose();
	});

	it("cancels an in-flight login and emits an unsuccessful terminal event", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		vi.spyOn(harness.authStorage, "login").mockImplementation(async (_providerId, callbacks) => {
			callbacks.onAuth({ url: "https://stub.example/oauth?code=PENDING" });
			await new Promise<void>((_resolve, reject) => {
				callbacks.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			});
		});
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		const url = collected.waitFor((message) => message.type === "auth_login_url");

		await handler.handleInputLine(JSON.stringify({ id: "start", type: "login_start", provider: "anthropic" }));
		await url;
		const end = collected.waitFor((message) => message.type === "auth_login_end");
		await handler.handleInputLine(JSON.stringify({ id: "cancel", type: "login_cancel", provider: "anthropic" }));

		expect(await collected.waitFor((message) => message.id === "cancel")).toMatchObject({ success: true });
		expect(await end).toMatchObject({ provider: "anthropic", success: false });
		await handler.dispose();
	});

	it("stores and removes an API-key credential through RPC commands", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(
			JSON.stringify({ id: "set-key", type: "login_api_key", provider: "openai", key: "sk-FAKEKEY-123" }),
		);
		expect(await collected.waitFor((message) => message.id === "set-key")).toMatchObject({ success: true });
		const stored = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<
			string,
			{ type: string; key: string }
		>;
		expect(stored.openai).toMatchObject({ type: "api_key", key: "sk-FAKEKEY-123" });
		expect(statSync(harness.authPath).mode & 0o777).toBe(0o600);

		await handler.handleInputLine(JSON.stringify({ id: "logout", type: "logout", provider: "openai" }));
		expect(await collected.waitFor((message) => message.id === "logout")).toMatchObject({ success: true });
		const afterLogout = JSON.parse(readFileSync(harness.authPath, "utf-8")) as Record<string, unknown>;
		expect(afterLogout.openai).toBeUndefined();
		await handler.dispose();
	});

	it("writes response records only to the injected sink", async () => {
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const stdoutSpy = vi.spyOn(process.stdout, "write");
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "state", type: "get_state" }));

		expect(await collected.waitFor((message) => message.id === "state")).toMatchObject({
			type: "response",
			command: "get_state",
			success: true,
		});
		expect(stdoutSpy).not.toHaveBeenCalled();
		stdoutSpy.mockRestore();
		await handler.dispose();
	});

	it("installs no process signal handlers and frames unknown commands as errors", async () => {
		const before = process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP");
		const collected = makeSink();
		const harness = makeHarness(tempDir);
		cleanup = harness.cleanup;
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);

		await handler.handleInputLine(JSON.stringify({ id: "unknown", type: "no_such_command" }));

		expect(process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP")).toBe(before);
		expect(await collected.waitFor((message) => message.id === "unknown")).toMatchObject({
			success: false,
			error: expect.stringContaining("Unknown command"),
		});
		await handler.dispose();
	});

	it("emits an optional custom-UI capability notice without changing default clients", async () => {
		const factory = (() => ({ render: () => "" })) as never;
		const flagged = makeSink();
		const flaggedHarness = makeHarness(tempDir);
		cleanup = flaggedHarness.cleanup;
		const flaggedHandler = createRpcConnectionHandler(flaggedHarness.runtimeHost, flagged.sink, {
			capabilities: ["custom_unsupported"],
		});
		await flaggedHandler.ready;
		const notice = flagged.waitFor(
			(message) => message.type === "extension_ui_request" && message.method === "custom_unsupported",
		);

		expect(await flaggedHarness.runtimeHost.session.extensionRunner.getUIContext().custom(factory)).toBeUndefined();
		expect(await notice).toMatchObject({ method: "custom_unsupported", extensionName: expect.any(String) });
		await flaggedHandler.dispose();
		flaggedHarness.cleanup();

		const plain = makeSink();
		const plainHarness = makeHarness(tempDir);
		cleanup = plainHarness.cleanup;
		const plainHandler = createRpcConnectionHandler(plainHarness.runtimeHost, plain.sink);
		await plainHandler.ready;

		expect(await plainHarness.runtimeHost.session.extensionRunner.getUIContext().custom(factory)).toBeUndefined();
		expect(
			plain
				.messages()
				.find((message) => message.type === "extension_ui_request" && message.method === "custom_unsupported"),
		).toBeUndefined();
		await plainHandler.dispose();
	});
});
