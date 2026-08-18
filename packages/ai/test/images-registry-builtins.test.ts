import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/images.ts";
import { getImagesApiProvider } from "../src/images-api-registry.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

const model: ImagesModel<"openai-images"> = {
	id: "gpt-image-2",
	name: "GPT Image 2",
	api: "openai-images",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	output: ["image"],
	cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
};
const context: ImagesContext = { input: [{ type: "text", text: "Draw a lighthouse" }] };

describe("openai-images builtin registry", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("registers a lazy generateImages for openai-images", () => {
		const provider = getImagesApiProvider("openai-images");
		expect(provider).toBeDefined();
		expect(typeof provider?.generateImages).toBe("function");
	});

	it("returns an error envelope when the underlying module import fails", async () => {
		// Force the dynamic import of the openai-images module to reject.
		vi.doMock("../../api/openai-images.ts", () => {
			throw new Error("module import failed");
		});

		const provider = getImagesApiProvider("openai-images");
		expect(provider).toBeDefined();

		const result = await generateImages(model, context, { apiKey: "test-key" });
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
		expect(result.output).toEqual([]);
	});

	it("returns an error envelope (never a thrown rejection) on import failure via direct provider call", async () => {
		vi.doMock("../../api/openai-images.ts", () => {
			throw new Error("module import failed");
		});

		const provider = getImagesApiProvider("openai-images");
		expect(provider).toBeDefined();

		// The lazy wrapper must catch the import failure and return an
		// AssistantImages with stopReason "error" — never a thrown rejection.
		const result = await provider?.generateImages(model, context, { apiKey: "test-key" });
		expect(result).toBeDefined();
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toBeTruthy();
	});
});
