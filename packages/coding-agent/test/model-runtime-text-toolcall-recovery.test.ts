import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { probeModelRuntimeImport } from "./helpers/esm-import-graph-probe.ts";
import { registerModelRuntimeRecoveryBoundaryCases } from "./model-runtime-text-toolcall-recovery-boundaries.ts";

const leak = '<invoke name="Echo"><parameter name="value">hello</parameter></invoke>';
const tools: Context["tools"] = [
	{
		name: "Echo",
		description: "Echo text",
		parameters: Type.Object({ value: Type.String() }),
	},
];

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "runtime-recovery",
		baseUrl: "https://selected.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	};
}

function scriptedStream(wireModel: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const partial = {
		role: "assistant" as const,
		api: wireModel.api,
		provider: wireModel.provider,
		model: wireModel.id,
		content: [{ type: "text" as const, text: leak }],
		usage,
		stopReason: "stop" as const,
		timestamp: 1,
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...partial, content: [] } });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: leak, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: leak, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}

async function setup(selectedModel: Model<Api>) {
	const calls: Array<{
		kind: "stream" | "simple";
		model: Model<Api>;
		context: Context;
		options: unknown;
	}> = [];
	const provider: Provider = {
		id: "runtime-recovery",
		name: "Runtime recovery",
		auth: {
			apiKey: {
				name: "test",
				resolve: async () => ({
					auth: { apiKey: "test", baseUrl: "https://wire.test/v1" },
					source: "test",
				}),
			},
		},
		getModels: () => [selectedModel],
		stream: (wireModel, context, options) => {
			calls.push({ kind: "stream", model: wireModel, context, options });
			return scriptedStream(wireModel);
		},
		streamSimple: (wireModel, context, options) => {
			calls.push({ kind: "simple", model: wireModel, context, options });
			return scriptedStream(wireModel);
		},
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(provider);
	return { runtime, selected: runtime.getModel(provider.id, selectedModel.id)!, calls };
}

describe("ModelRuntime text tool-call recovery", () => {
	it("wraps stream and streamSimple through the side-effect-free AI root", async () => {
		const { runtime, selected, calls } = await setup(model("claude-selected"));
		const context = { messages: [], tools } satisfies Context;
		const options = { headers: { "x-once": "yes" } };
		const results = await Promise.all([
			runtime.stream(selected, context, options).result(),
			runtime.streamSimple(selected, context, options).result(),
		]);

		for (const result of results) {
			expect(result.content).toEqual([
				{ type: "toolCall", id: "recovered-antml-0", name: "Echo", arguments: { value: "hello" } },
			]);
			expect(result.stopReason).toBe("toolUse");
		}
		expect(calls.map((call) => call.kind)).toEqual(["stream", "simple"]);
		for (const call of calls) {
			expect(call.model.id).toBe("claude-selected");
			expect(call.model.baseUrl).toBe("https://wire.test/v1");
			expect(call.context).toBe(context);
			expect(call.options).toMatchObject({ headers: { "x-once": "yes" }, apiKey: "test" });
		}
	});

	it("skips recovery for empty tools non-Claude defaults explicit false and text protocols", async () => {
		const cases = [
			{ selected: model("claude-empty"), context: { messages: [], tools: [] } satisfies Context },
			{ selected: model("unrelated"), context: { messages: [], tools } satisfies Context },
			{
				selected: model("claude-disabled", { recoverTextToolCalls: false }),
				context: { messages: [], tools } satisfies Context,
			},
			{
				selected: model("claude-text", { api: "openai-completions", compat: { toolCallFormat: "antml" } }),
				context: { messages: [], tools } satisfies Context,
			},
		];
		for (const entry of cases) {
			const { runtime, selected, calls } = await setup(entry.selected);
			const result = await runtime.streamSimple(selected, entry.context).result();
			expect(result.content).toEqual([{ type: "text", text: leak }]);
			expect(calls).toHaveLength(1);
		}
		const enabled = await setup(model("unrelated-enabled", { recoverTextToolCalls: true }));
		const result = await enabled.runtime.streamSimple(enabled.selected, { messages: [], tools }).result();
		expect(result.content[0]?.type).toBe("toolCall");
		expect(enabled.calls).toHaveLength(1);
	});

	it("does not import the AI compat entrypoint", () => {
		const repoRoot = new URL("../../..", import.meta.url).pathname;
		for (const target of ["source", "built"] as const) {
			const result = probeModelRuntimeImport(repoRoot, target);
			const graph = result.entries.map((entry) => `${entry.specifier ?? ""} ${entry.url}`).join("\n");
			expect(graph).toContain("@earendil-works/pi-ai");
			const compatEntries = result.entries.filter(
				(entry) =>
					entry.specifier === "@earendil-works/pi-ai/compat" ||
					/\/pi-ai\/(?:src|dist)\/compat\.(?:ts|js)$/u.test(entry.url),
			);
			expect(compatEntries).toEqual([]);
			expect(result.globalsAdded.filter((key) => !key.startsWith("Symbol("))).toEqual([]);
		}
	});

	registerModelRuntimeRecoveryBoundaryCases();
});
