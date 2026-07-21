import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import gptApplyPatchExtension from "../../src/core/extensions/builtin/gpt-apply-patch/index.ts";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import {
	createRpcConnectionHandler,
	type RpcConnectionHandler,
	type RpcConnectionSink,
} from "../../src/modes/rpc/connection-handler.ts";
import { createHarness } from "./harness.ts";

const GPT_PROVIDER = "gpt-proxy";

interface RpcResponseLine {
	id?: string;
	command?: string;
	success?: boolean;
	error?: string;
}

function createRuntimeHost(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function responseLines(lines: string[]): RpcResponseLine[] {
	return lines
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RpcResponseLine);
}

async function setModelViaRpc(
	handler: RpcConnectionHandler,
	lines: string[],
	id: string,
	provider: string,
	modelId: string,
): Promise<RpcResponseLine> {
	await handler.handleInputLine(JSON.stringify({ id, type: "set_model", provider, modelId }));
	const response = responseLines(lines).find((message) => message.id === id && message.command === "set_model");
	if (!response) throw new Error(`Missing RPC set_model response for ${id}`);
	return response;
}

describe("RPC set_model mid-session switch", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("swaps the toolset and prompt guidance atomically through the RPC surface", async () => {
		// Given: a non-GPT session with the apply_patch extension and a Responses-API GPT provider.
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "proxy",
			models: [{ id: "claude-sonnet" }],
			extensionFactories: [
				gptApplyPatchExtension,
				promptPresetExtension,
				(pi) => {
					pi.registerProvider(GPT_PROVIDER, {
						baseUrl: "https://example.invalid/v1",
						apiKey: "faux-key",
						api: "openai-responses",
						models: [
							{
								id: "gpt-5.5",
								name: "gpt-5.5",
								api: "openai-responses",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		const lines: string[] = [];
		const sink: RpcConnectionSink = {
			writeRaw: (chunk) => lines.push(chunk),
			waitForBackpressure: async () => {},
		};
		const handler = createRpcConnectionHandler(createRuntimeHost(harness.session), sink);
		cleanups.push(() => handler.dispose());
		await handler.ready;
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);

		// When: an RPC client switches to a Responses-API GPT model mid-session.
		const toGpt = await setModelViaRpc(handler, lines, "sw1", GPT_PROVIDER, "gpt-5.5");

		// Then: the toolset and the prompt guidance update in the same turn.
		expect(toGpt.success).toBe(true);
		expect(harness.session.model?.id).toBe("gpt-5.5");
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "apply_patch"]);
		expect(harness.session.systemPrompt).toContain("- apply_patch:");
		expect(harness.session.systemPrompt).not.toContain("- edit:");

		// When: the RPC client switches back to the non-GPT model.
		const backToNonGpt = await setModelViaRpc(handler, lines, "sw2", "proxy", "claude-sonnet");

		// Then: the edit tools and their guidance return.
		expect(backToNonGpt.success).toBe(true);
		expect(harness.session.getActiveToolNames()).toEqual(["read", "bash", "edit", "write"]);
		expect(harness.session.systemPrompt).toContain("- edit:");
		expect(harness.session.systemPrompt).not.toContain("- apply_patch:");
	});
});
