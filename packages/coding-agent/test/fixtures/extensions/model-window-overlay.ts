import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("overlay-fixture", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "fixture-key",
		models: [
			{
				id: "sample",
				name: "Sample",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64_000,
				maxTokens: 4_000,
			},
		],
	});
	pi.setModelWindowOverrides("overlay-fixture", { sample: 160_000 });
}
