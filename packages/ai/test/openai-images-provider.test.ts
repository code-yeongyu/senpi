import { describe, expect, it } from "vitest";
import { isModelType } from "../src/models.ts";
import { builtinModels } from "../src/providers/all.ts";
import { openaiProvider } from "../src/providers/openai.ts";

describe("openai images provider", () => {
	it("registers openai-images generation on the openai provider", () => {
		const provider = openaiProvider();
		expect(provider.generateImages).toBeDefined();
		expect(provider.getModels().every((model) => isModelType(model, "chat"))).toBe(true);
		expect(
			provider.getAllModels?.().some((model) => isModelType(model, "image") && model.api === "openai-images"),
		).toBe(true);
		expect(builtinModels().getProvider("openai")).toBeDefined();
	});

	it.each(["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"])(
		"exposes %s with text and image inputs",
		(id) => {
			const model = builtinModels().getModelOfType("image", "openai", id);
			expect(model).toBeDefined();
			expect(model?.type).toBe("image");
			expect(model?.api).toBe("openai-images");
			expect(model?.provider).toBe("openai");
			expect(model?.baseUrl).toBe("https://api.openai.com/v1");
			expect(model?.input).toEqual(["text", "image"]);
			expect(model?.output).toEqual(["image"]);
		},
	);

	it("exposes gpt-image-1.5 as a text-only openai-images model", () => {
		const model = builtinModels().getModelOfType("image", "openai", "gpt-image-1.5");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-images");
		expect(model?.provider).toBe("openai");
		expect(model?.input).toEqual(["text"]);
		expect(model?.output).toEqual(["image"]);
	});
});
