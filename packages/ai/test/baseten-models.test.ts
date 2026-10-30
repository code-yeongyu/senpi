import { afterEach, describe, expect, it } from "vitest";
import { getModel, getModels, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";

const originalBasetenApiKey = process.env.BASETEN_API_KEY;

afterEach(() => {
	if (originalBasetenApiKey === undefined) {
		delete process.env.BASETEN_API_KEY;
	} else {
		process.env.BASETEN_API_KEY = originalBasetenApiKey;
	}
});

describe("Baseten models", () => {
	it("keeps both GLM 5.2 endpoints text-only", () => {
		expect(getModel("baseten", "zai-org/GLM-5.2").input).toEqual(["text"]);
		expect(getModel("baseten", "zai-org/GLM-5.2-Fast").input).toEqual(["text"]);
	});

	it("sends a toggle-only reasoning model's thinking as chat_template_args, never as reasoning_effort", async () => {
		// The catalog decides which Baseten rows are toggle-only and they come and go upstream, so this builds the
		// toggle-only shape the generator emits instead of pinning a model id that can drop out of models.dev.
		const base = getModels("baseten")[0];
		expect(base).toBeDefined();
		const model = {
			...base,
			id: "fixture/toggle-only",
			reasoning: true,
			thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
			compat: {
				...base.compat,
				supportsReasoningEffort: false,
				thinkingFormat: "baseten",
				chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		} as typeof base;
		let payload: Record<string, unknown> | undefined;

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBeUndefined();
	});

	it("keeps every toggle-only Baseten row in the catalog on the explicit off/on map", () => {
		for (const model of getModels("baseten")) {
			if (model.compat?.thinkingFormat !== "baseten" || model.compat.supportsReasoningEffort) continue;
			expect(model.thinkingLevelMap).toEqual({
				off: "off",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			});
		}
	});

	it("sends Baseten chat_template_args with reasoning effort", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBe("high");
	});

	it("disables Baseten opt-in reasoning when thinking is off", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: false });
		expect(payload?.reasoning_effort).toBe("none");
	});

	it("resolves BASETEN_API_KEY from the environment", () => {
		process.env.BASETEN_API_KEY = "test-baseten-key";

		expect(findEnvKeys("baseten")).toEqual(["BASETEN_API_KEY"]);
		expect(getEnvApiKey("baseten")).toBe("test-baseten-key");
	});
});
