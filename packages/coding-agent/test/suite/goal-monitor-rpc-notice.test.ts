import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import goalExtension from "../../src/core/extensions/builtin/goal/index.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

interface RpcRecord {
	readonly type?: string;
	readonly method?: string;
	readonly message?: string;
	readonly notifyType?: string;
	readonly entry?: { readonly customType?: string; readonly data?: { readonly phase?: string } };
}

function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

function rpcRecords(chunks: readonly string[]): RpcRecord[] {
	return chunks
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RpcRecord);
}

describe("goal monitor scheduling notice over RPC", () => {
	const harnesses: Harness[] = [];
	const handlers: RpcConnectionHandler[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		while (handlers.length > 0) await handlers.pop()?.dispose();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("emits a scheduling event and one durable RPC entry", async () => {
		vi.useFakeTimers();
		const scheduleEvents: unknown[] = [];
		const harness = await createHarness({
			extensionFactories: [
				goalExtension,
				(pi) => {
					pi.on("session_start", async () => {
						pi.events.on("goal_continuation_scheduled", (data) => scheduleEvents.push(data));
						await pi.executeTool("create_goal", { objective: "Watch the RPC monitor" });
						pi.events.emit("terminal_monitor_state", { activeCount: 1 });
					});
				},
			],
		});
		harnesses.push(harness);
		const chunks: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => chunks.push(chunk),
			waitForBackpressure: async () => {},
		};
		const handler = createRpcConnectionHandler(createRuntimeHost(harness.session), sink);
		handlers.push(handler);
		await handler.ready;

		const runner = harness.getExtensionRunner();
		await runner.emit({ type: "agent_start" });
		await runner.emit({ type: "agent_end", messages: [fauxAssistantMessage("clean stop")] });

		expect(scheduleEvents).toEqual([expect.objectContaining({ delayMs: 240_000 })]);
		const records = rpcRecords(chunks);
		expect(records).toContainEqual(
			expect.objectContaining({
				type: "entry_appended",
				entry: expect.objectContaining({
					customType: "goal-cache-warmup",
					data: expect.objectContaining({ phase: "scheduled" }),
				}),
			}),
		);
		expect(records.some((record) => record.method === "notify")).toBe(false);
	});
});
