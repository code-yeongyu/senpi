import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness, deferred, within } from "../prompt-cache-prewarm-harness.ts";

describe("real runtime and RPC prewarm admission (#3140)", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	async function createRuntime() {
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		let providerCalls = 0;
		const recordProvider = (session: typeof harness.session) => {
			const stream = session.agent.streamFunction;
			session.agent.streamFunction = (...args) => {
				providerCalls += 1;
				return stream(...args);
			};
		};
		recordProvider(harness.session);
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			});
			recordProvider(result.session);
			return { ...result, services, diagnostics: [] };
		};
		const runtime = new AgentSessionRuntime(harness.session, services, factory);
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});
		cleanups.push(() => runtime.dispose());
		return { runtime, harness, warm, providerCalls: () => providerCalls };
	}

	it("does not call a provider when opening the runtime", async () => {
		vi.useFakeTimers();
		const fixture = await createRuntime();

		await fixture.runtime.session.bindExtensions({});
		await vi.runAllTimersAsync();

		expect(fixture.providerCalls()).toBe(0);
		expect(fixture.warm).not.toHaveBeenCalled();
	});

	it("does not call a provider when resuming a persisted conversation", async () => {
		vi.useFakeTimers();
		const fixture = await createRuntime();
		await fixture.runtime.session.bindExtensions({});
		const saved = SessionManager.create(fixture.harness.tempDir, join(fixture.harness.tempDir, "saved"));
		saved.appendMessage({ role: "user", content: "previous input", timestamp: 1 });
		saved.appendMessage(fauxAssistantMessage("previous answer"));
		const file = saved.getSessionFile();
		if (file === undefined) throw new Error("Missing persisted fixture");

		const result = await fixture.runtime.switchSession(file);
		await vi.runAllTimersAsync();

		expect(result.cancelled).toBe(false);
		expect(fixture.providerCalls()).toBe(0);
		expect(fixture.warm).not.toHaveBeenCalled();
	});

	it("does not call a provider when forking a conversation", async () => {
		vi.useFakeTimers();
		const fixture = await createRuntime();
		await fixture.runtime.session.bindExtensions({});
		const id = fixture.runtime.session.sessionManager.appendMessage({
			role: "user",
			content: "fork point",
			timestamp: 1,
		});
		fixture.runtime.session.sessionManager.appendMessage(fauxAssistantMessage("previous answer"));

		const result = await fixture.runtime.fork(id);
		await vi.runAllTimersAsync();

		expect(result.cancelled).toBe(false);
		expect(fixture.providerCalls()).toBe(0);
		expect(fixture.warm).not.toHaveBeenCalled();
	});

	it("sends the first JSONL RPC prompt with exactly one provider call", async () => {
		vi.useFakeTimers();
		const fixture = await createRuntime();
		fixture.harness.setResponses([fauxAssistantMessage("answer")]);
		const lines: string[] = [];
		const handler = createRpcConnectionHandler(fixture.runtime, {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		});
		cleanups.push(async () => handler.dispose());
		await handler.ready;
		await vi.runAllTimersAsync();
		expect(fixture.warm).not.toHaveBeenCalled();
		const ended = deferred<void>();
		const unsubscribe = fixture.runtime.session.subscribe((event) => {
			if (event.type === "agent_end") ended.resolve();
		});
		try {
			await handler.handleInputLine(JSON.stringify({ id: "first", type: "prompt", message: "hello" }));
			await within(ended.promise, "RPC turn completion");

			expect(fixture.providerCalls()).toBe(1);
			expect(fixture.warm).not.toHaveBeenCalled();
			const frames: unknown[] = lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			expect(
				frames.find(
					(frame) => typeof frame === "object" && frame !== null && "id" in frame && frame.id === "first",
				),
			).toMatchObject({ type: "response", id: "first", command: "prompt", success: true });
		} finally {
			unsubscribe();
		}
	});
});
