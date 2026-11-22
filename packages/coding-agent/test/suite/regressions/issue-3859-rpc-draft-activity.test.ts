import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
} from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { multiSessionHostCapabilities } from "../../../src/modes/rpc/host-capabilities.ts";
import { USER_ACTIVITY_CAPABILITY } from "../../../src/modes/rpc/rpc-types.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness, within } from "../prompt-cache-prewarm-harness.ts";

describe("RPC draft activity starts the first-activity prewarm (#3859)", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	async function connect(keepAliveEnabled: boolean) {
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness, warmCalled } = await createPrewarmHarness(warm, {
			settings: { promptCache: { keepAlive: { enabled: keepAliveEnabled } } },
		});
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
		const lines: string[] = [];
		const handler = createRpcConnectionHandler(runtime, {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		});
		cleanups.push(async () => handler.dispose());
		await handler.ready;
		const response = (id: string): unknown =>
			lines
				.join("")
				.split("\n")
				.filter(Boolean)
				.map((line): unknown => JSON.parse(line))
				.find((frame) => typeof frame === "object" && frame !== null && "id" in frame && frame.id === id);
		const send = (command: Record<string, unknown>) => handler.handleInputLine(JSON.stringify(command));
		return { warm, warmCalled, send, response, providerCalls: () => providerCalls };
	}

	it("warms the prompt cache once when the client reports the first draft", async () => {
		const fixture = await connect(true);
		expect(fixture.warm).not.toHaveBeenCalled();

		await fixture.send({ id: "draft-1", type: "record_user_activity", kind: "draft" });
		await within(fixture.warmCalled, "the draft prewarm");
		await fixture.send({ id: "draft-2", type: "record_user_activity", kind: "draft" });

		expect(fixture.response("draft-1")).toMatchObject({
			type: "response",
			command: "record_user_activity",
			success: true,
		});
		expect(fixture.response("draft-2")).toMatchObject({ command: "record_user_activity", success: true });
		expect(fixture.warm).toHaveBeenCalledTimes(1);
		expect(fixture.providerCalls()).toBe(0);
	});

	it("contacts no provider for a draft when keep-alive is disabled", async () => {
		vi.useFakeTimers();
		const fixture = await connect(false);

		await fixture.send({ id: "draft", type: "record_user_activity", kind: "draft" });
		await vi.runAllTimersAsync();

		expect(fixture.response("draft")).toMatchObject({ command: "record_user_activity", success: true });
		expect(fixture.warm).not.toHaveBeenCalled();
		expect(fixture.providerCalls()).toBe(0);
	});

	it.each(["prompt", "typing", undefined])("refuses activity kind %s without contacting a provider", async (kind) => {
		vi.useFakeTimers();
		const fixture = await connect(true);

		await fixture.send({ id: "bad", type: "record_user_activity", ...(kind === undefined ? {} : { kind }) });
		await vi.runAllTimersAsync();

		expect(fixture.response("bad")).toMatchObject({
			command: "record_user_activity",
			success: false,
			errorCode: "invalid_argument",
		});
		expect(fixture.warm).not.toHaveBeenCalled();
		expect(fixture.providerCalls()).toBe(0);
	});

	it("advertises user_activity from both classic and multi-session hosts", async () => {
		const fixture = await connect(false);

		await fixture.send({ id: "info", type: "get_protocol_info" });

		expect(fixture.response("info")).toMatchObject({
			success: true,
			data: { capabilities: expect.arrayContaining([USER_ACTIVITY_CAPABILITY]) },
		});
		expect(multiSessionHostCapabilities({ warm: false, toolRuntime: "in-process", negotiated: [] })).toContain(
			USER_ACTIVITY_CAPABILITY,
		);
	});
});
