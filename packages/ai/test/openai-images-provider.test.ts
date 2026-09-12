import { describe, expect, it } from "vitest";
import { builtinImagesModels } from "../src/providers/all.ts";

describe("openai images provider", () => {
	it("registers the openai provider in builtinImagesModels", () => {
		const models = builtinImagesModels();
		expect(models.getProvider("openai")).toBeDefined();
	});

	it.each(["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"])(
		"exposes %s with text and image inputs",
		(id) => {
			const models = builtinImagesModels();
			const model = models.getModel("openai", id);
			expect(model).toBeDefined();
			expect(model?.api).toBe("openai-images");
			expect(model?.provider).toBe("openai");
			expect(model?.baseUrl).toBe("https://api.openai.com/v1");
			expect(model?.input).toEqual(["text", "image"]);
			expect(model?.output).toEqual(["image"]);
		},
	);

	it("exposes gpt-image-1.5 as a text-only openai-images model", () => {
		const models = builtinImagesModels();
		const model = models.getModel("openai", "gpt-image-1.5");
		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-images");
		expect(model?.provider).toBe("openai");
		expect(model?.input).toEqual(["text"]);
		expect(model?.output).toEqual(["image"]);
	});
});
