import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { findInitialModel } from "../src/core/model-resolver.ts";

describe("OpenAI provider defaults", () => {
	test("prefers GPT-5.6 Sol automatically while preserving explicit GPT-5.5", async () => {
		const openAiModels = getModels("openai");
		const codexModels = getModels("openai-codex");
		const availableModels = [
			openAiModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.5"),
		].filter((model) => model !== undefined);
		const runtime = {
			getAvailableSnapshot: () => availableModels,
			getModel: (provider: string, modelId: string) =>
				availableModels.find((model) => model.provider === provider && model.id === modelId),
			hasConfiguredAuth: () => true,
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const automatic = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		const explicit = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "openai-codex",
			defaultModelId: "gpt-5.5",
			modelRuntime: runtime,
		});

		expect(automatic.model?.id).toBe("gpt-5.6-sol");
		expect(automatic.provenance).toBe("provider-default");
		expect(explicit.model?.id).toBe("gpt-5.5");
		expect(explicit.provenance).toBe("settings");
	});
});
