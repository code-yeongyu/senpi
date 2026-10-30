import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

interface WireRecord {
	id?: string;
	type?: string;
	success?: boolean;
	errorCode?: string;
	data?: Record<string, unknown>;
}

function runtimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("3819 get_model_thinking_level reads a model's level without switching to it", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function open(): Promise<{ harness: Harness; send(command: Record<string, unknown>): Promise<WireRecord> }> {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "model-a", reasoning: true },
				{ id: "model-b", reasoning: true },
			],
		});
		cleanups.push(harness.cleanup);
		const lines: string[] = [];
		const sink: RpcConnectionSink = { writeRaw: (chunk) => lines.push(chunk), waitForBackpressure: async () => {} };
		const handler: RpcConnectionHandler = createRpcConnectionHandler(runtimeHost(harness.session), sink);
		cleanups.push(() => handler.dispose());
		await handler.ready;
		let sequence = 0;
		return {
			harness,
			send: async (command) => {
				const id = `r-${++sequence}`;
				await handler.handleInputLine(JSON.stringify({ id, ...command }));
				const records = lines
					.join("")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as WireRecord);
				const response = records.find((record) => record.id === id && record.type === "response");
				if (!response) throw new Error(`no response for ${JSON.stringify(command)}`);
				return response;
			},
		};
	}

	it("answers the level set_model would restore, and the current level for the active model", async () => {
		const { harness, send } = await open();
		await send({ type: "set_model", provider: "faux", modelId: "model-a" });
		await send({ type: "set_thinking_level", level: "high", scope: "turn" });
		await send({ type: "set_model", provider: "faux", modelId: "model-b" });
		await send({ type: "set_thinking_level", level: "low", scope: "turn" });

		const a = await send({ type: "get_model_thinking_level", provider: "faux", modelId: "model-a" });
		expect(a.success).toBe(true);
		expect(a.data).toMatchObject({ level: "high", source: "session" });
		expect(a.data?.availableLevels).toContain("high");
		expect(harness.session.model?.id).toBe("model-b");
		expect(harness.session.thinkingLevel).toBe("low");

		const b = await send({ type: "get_model_thinking_level", provider: "faux", modelId: "model-b" });
		expect(b.data).toMatchObject({ level: "low", source: "explicit" });

		await send({ type: "set_model", provider: "faux", modelId: "model-a" });
		const state = await send({ type: "get_state" });
		expect(state.data).toMatchObject({ thinkingLevel: a.data?.level, thinkingLevelSource: a.data?.source });
	});

	it("refuses an unknown model and a malformed request", async () => {
		const { send } = await open();
		expect(await send({ type: "get_model_thinking_level", provider: "faux", modelId: "nope" })).toMatchObject({
			success: false,
			errorCode: "model_not_found",
		});
		expect(await send({ type: "get_model_thinking_level", provider: "faux" })).toMatchObject({
			success: false,
			errorCode: "invalid_argument",
		});
	});
});
