import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

async function captureStreamOptions(harness: Harness): Promise<SimpleStreamOptions[]> {
	const captured: SimpleStreamOptions[] = [];
	const inner = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (model, context, options) => {
		captured.push(options ?? {});
		return inner(model, context, options);
	};
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("hello");
	return captured;
}

describe("abortServerSideFallback reaches the provider options", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("enables the abort when the current model has a configured chain", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { fallbackChains: { "faux/faux-1": ["faux/faux-2"] } } },
		});
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.abortServerSideFallback).toBe(true);
	});

	it("follows the server fallback when the current model has no configured chain", async () => {
		const harness = await createHarness({ settings: { retry: { fallbackChains: {} } } });
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});

	it("forwards an explicit opt-out", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					abortServerSideFallback: false,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		const captured = await captureStreamOptions(harness);
		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});

	it("enables the abort after cycling onto a model with a configured chain", async () => {
		let harness: Harness;
		const cycleTool: AgentTool = {
			name: "cycle_model",
			label: "Cycle model",
			description: "Cycle to the next favorite model",
			parameters: Type.Object({}),
			execute: async () => {
				const cycled = await harness.session.cycleModel("forward");
				expect(cycled?.model.id).toBe("faux-1");
				return { content: [{ type: "text", text: "cycled" }], details: {} };
			},
		};
		harness = await createHarness({
			models: [{ id: "faux-0" }, { id: "faux-1" }, { id: "faux-2" }],
			tools: [cycleTool],
			settings: {
				retry: { fallbackChains: { "faux/faux-1": ["faux/faux-2"] } },
			},
		});
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.models[0] }, { model: harness.models[1] }]);

		const captured: Array<{ model: string; options: SimpleStreamOptions }> = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			captured.push({ model: model.id, options: options ?? {} });
			return inner(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cycle_model", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(captured.map((request) => request.model)).toEqual(["faux-0", "faux-1"]);
		expect(captured[1]?.options.abortServerSideFallback).toBe(true);
	});

	it("keeps an explicit opt-out after cycling onto a configured chain", async () => {
		let harness: Harness;
		const cycleTool: AgentTool = {
			name: "cycle_model",
			label: "Cycle model",
			description: "Cycle to the next favorite model",
			parameters: Type.Object({}),
			execute: async () => {
				await harness.session.cycleModel("forward");
				return { content: [{ type: "text", text: "cycled" }], details: {} };
			},
		};
		harness = await createHarness({
			models: [{ id: "faux-0" }, { id: "faux-1" }, { id: "faux-2" }],
			tools: [cycleTool],
			settings: {
				retry: {
					abortServerSideFallback: false,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.models[0] }, { model: harness.models[1] }]);

		const captured: SimpleStreamOptions[] = [];
		const inner = harness.session.agent.streamFunction;
		harness.session.agent.streamFunction = (model, context, options) => {
			captured.push(options ?? {});
			return inner(model, context, options);
		};
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cycle_model", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hello");

		expect(captured[1]?.abortServerSideFallback).toBe(false);
	});

	it("refreshes the policy after a model switch", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { fallbackChains: { "faux/faux-1": ["faux/faux-2"] } } },
		});
		harnesses.push(harness);
		const fallbackModel = harness.getModel("faux-2");
		expect(fallbackModel).toBeDefined();
		if (!fallbackModel) return;

		await harness.session.setModel(fallbackModel);
		const captured = await captureStreamOptions(harness);

		expect(captured[0]?.abortServerSideFallback).toBe(false);
	});
});
