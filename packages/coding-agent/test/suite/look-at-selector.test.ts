import type { Api, Model } from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOK_AT_CHAIN, resolveVisionModel } from "../../src/core/extensions/builtin/look-at/model-selector.ts";
import { createHarness, type Harness } from "./harness.ts";

interface ProviderSnapshot {
	provider: string;
	models: FauxModelDefinition[];
}

const harnesses: Harness[] = [];

async function getAvailable(providers: ProviderSnapshot[]): Promise<Model<Api>[]> {
	const snapshots = await Promise.all(
		providers.map(async ({ provider, models }) => {
			const harness = await createHarness({ api: `faux-${provider}`, provider, models });
			harnesses.push(harness);
			return harness.models;
		}),
	);
	return snapshots.flat();
}

function vision(id: string): FauxModelDefinition {
	return { id, input: ["text", "image"] };
}

function textOnly(id: string): FauxModelDefinition {
	return { id, input: ["text"] };
}

describe("resolveVisionModel", () => {
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("(a) follows the default chain after filtering out text-only models", async () => {
		const available = await getAvailable([
			{ provider: "openai", models: [textOnly("gpt-5.6-terra")] },
			{ provider: "google", models: [vision("gemini-3.1-pro-preview")] },
		]);

		expect(resolveVisionModel(DEFAULT_LOOK_AT_CHAIN, available)).toMatchObject({
			model: { provider: "google", id: "gemini-3.1-pro-preview" },
			thinkingLevel: "low",
		});
	});

	it("(b) never returns a text-only exact match", async () => {
		const available = await getAvailable([
			{ provider: "openai", models: [textOnly("target")] },
			{ provider: "google", models: [vision("fallback")] },
		]);

		expect(resolveVisionModel(["target"], available)?.model).toMatchObject({ provider: "google", id: "fallback" });
	});

	it("(c) normalizes an explicit off suffix to undefined", async () => {
		const available = await getAvailable([{ provider: "openai", models: [vision("target")] }]);

		expect(resolveVisionModel(["target:off"], available)).toEqual({ model: available[0], thinkingLevel: undefined });
	});

	it("(d) preserves a valid explicit thinking suffix", async () => {
		const available = await getAvailable([{ provider: "openai", models: [vision("target")] }]);

		expect(resolveVisionModel(["target:high"], available)).toMatchObject({ thinkingLevel: "high" });
	});

	it("(e) keeps colons in model IDs when their suffix is not a thinking level", async () => {
		const available = await getAvailable([{ provider: "openai", models: [vision("target:exacto")] }]);

		expect(resolveVisionModel(["target:exacto"], available)?.model).toBe(available[0]);
	});

	it("(f) resolves canonical provider/model references before bare-id ambiguity", async () => {
		const available = await getAvailable([
			{ provider: "google", models: [vision("shared")] },
			{ provider: "moonshotai", models: [vision("shared")] },
		]);

		expect(resolveVisionModel(["moonshotai/shared"], available)?.model).toBe(available[1]);
	});

	it("(g) prefers OpenAI, Google, then Moonshot AI for ambiguous bare IDs", async () => {
		const available = await getAvailable([
			{ provider: "moonshotai", models: [vision("shared")] },
			{ provider: "google", models: [vision("shared")] },
			{ provider: "openai", models: [vision("shared")] },
		]);

		expect(resolveVisionModel(["shared"], available)?.model).toBe(available[2]);
	});

	it("(h) resolves otherwise ambiguous bare IDs by alphabetical provider order", async () => {
		const available = await getAvailable([
			{ provider: "zebra", models: [vision("shared")] },
			{ provider: "alpha", models: [vision("shared")] },
		]);

		expect(resolveVisionModel(["shared"], available)?.model).toBe(available[1]);
	});

	it("(i) falls back to parseModelPattern for fuzzy model references", async () => {
		const available = await getAvailable([{ provider: "google", models: [vision("gemini-3.5-flash-preview")] }]);

		expect(resolveVisionModel(["gemini-3.5-flash"], available)?.model).toBe(available[0]);
	});

	it("(j) returns the first vision candidate as a final fallback and undefined without vision", async () => {
		const available = await getAvailable([
			{ provider: "openai", models: [vision("first"), vision("second")] },
			{ provider: "google", models: [textOnly("text-only")] },
		]);

		expect(resolveVisionModel(["missing"], available)?.model).toBe(available[0]);
		expect(
			resolveVisionModel(
				["missing"],
				available.filter((model) => !model.input.includes("image")),
			),
		).toBeUndefined();
	});
});
