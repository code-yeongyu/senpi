import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages, type OpenAIImagesOptions } from "../src/api/openai-images.ts";
import type { ImageContent, ImagesContext, ImagesModel } from "../src/types.ts";

const mockState = vi.hoisted(() => {
	const response: Record<string, unknown> = {};
	return {
		generate: vi.fn(),
		edit: vi.fn(),
		toFile: vi.fn(
			async (bytes: Uint8Array, name: string, options: FilePropertyBag) =>
				new File([Uint8Array.from(bytes)], name, options),
		),
		response,
	};
});
vi.mock("openai", () => ({
	default: class FakeOpenAI {
		images = { generate: mockState.generate, edit: mockState.edit };
	},
	toFile: mockState.toFile,
}));

const png: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const ENCODED = { png: png.data, jpeg: "/9j/4AAQSkZJRg==", webp: "UklGRiQAAABXRUJQVlA4" } as const;
const mask: ImageContent = { type: "image", data: "iVBORw0KGgoAAAANSUhEUg==", mimeType: "image/png" };
const model: ImagesModel<"openai-images"> = {
	id: "gpt-image-2.5-flare",
	name: "GPT Image 2.5 Flare",
	api: "openai-images",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0, imageInput: 8 },
};
const context: ImagesContext = { input: [{ type: "text", text: "A red circle" }] };
const editContext: ImagesContext = { input: [...context.input, png] };

function run(options: OpenAIImagesOptions = {}, input = context, target = model) {
	return generateImages(target, input, { apiKey: "test-key", ...options });
}
function lastParams(fn: typeof mockState.generate): Record<string, unknown> {
	return fn.mock.calls.at(-1)?.[0];
}
function noRequests(): void {
	expect(mockState.generate).not.toHaveBeenCalled();
	expect(mockState.edit).not.toHaveBeenCalled();
}

describe("OpenAI images output options", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockState.response = { data: [{ b64_json: png.data }], usage: { input_tokens: 10, output_tokens: 20 } };
		const response = () => ({
			withResponse: async () => ({
				data: mockState.response,
				response: { status: 200, headers: new Headers() },
			}),
		});
		mockState.generate.mockImplementation(response);
		mockState.edit.mockImplementation(response);
	});

	it("keeps the default wire body free of the optional fields", async () => {
		expect((await run()).stopReason).toBe("stop");
		const params = lastParams(mockState.generate);
		expect(params).toMatchObject({ output_format: "png" });
		for (const key of ["background", "output_compression", "moderation", "mask"]) {
			expect(params).not.toHaveProperty(key);
		}
	});

	it("forwards background, output_format, output_compression, and moderation exactly as passed", async () => {
		const result = await run({
			background: "opaque",
			outputFormat: "webp",
			outputCompression: 60,
			moderation: "low",
		});
		expect(result.stopReason).toBe("stop");
		expect(lastParams(mockState.generate)).toMatchObject({
			background: "opaque",
			output_format: "webp",
			output_compression: 60,
			moderation: "low",
		});
	});

	it.each([
		["png", "image/png"],
		["jpeg", "image/jpeg"],
		["webp", "image/webp"],
	] as const)("labels b64 payloads with the %s MIME type", async (outputFormat, mimeType) => {
		mockState.response = { ...mockState.response, data: [{ b64_json: ENCODED[outputFormat] }] };
		const result = await run({ outputFormat });
		expect(result.output).toEqual([{ type: "image", data: ENCODED[outputFormat], mimeType }]);
	});

	it("labels b64 payloads by their magic bytes when a gateway ignores output_format", async () => {
		const result = await run({ outputFormat: "webp" });
		expect(result.output).toEqual([{ type: "image", data: png.data, mimeType: "image/png" }]);
		mockState.response = { ...mockState.response, data: [{ b64_json: "AAAAAAAAAAAAAAAAAAAAAAAA" }] };
		expect((await run({ outputFormat: "webp" })).output[0]).toMatchObject({ mimeType: "image/webp" });
	});

	it("echoes the response background and leaves it unset for auto", async () => {
		mockState.response = { ...mockState.response, background: "transparent" };
		expect(await run({ background: "transparent" })).toMatchObject({ background: "transparent" });
		mockState.response = { ...mockState.response, background: "auto" };
		expect(await run()).not.toHaveProperty("background");
	});

	it("uploads the mask alongside the reference images", async () => {
		expect((await run({ mask }, editContext)).stopReason).toBe("stop");
		expect(mockState.generate).not.toHaveBeenCalled();
		const params = lastParams(mockState.edit);
		expect(params.image).toHaveLength(1);
		expect(params.mask).toBeInstanceOf(File);
		expect(params.mask).toMatchObject({ name: "mask.png", type: "image/png" });
		expect(mockState.toFile).toHaveBeenCalledWith(Buffer.from(mask.data, "base64"), "mask.png", {
			type: "image/png",
		});
	});

	it("prices image input tokens separately from text input tokens", async () => {
		mockState.response = {
			...mockState.response,
			usage: {
				input_tokens: 30,
				input_tokens_details: { text_tokens: 10, image_tokens: 20 },
				output_tokens: 20,
				total_tokens: 50,
			},
		};
		const usage = (await run({}, editContext)).usage;
		expect(usage).toMatchObject({ input: 30, output: 20, totalTokens: 50 });
		expect(usage?.cost.input).toBeCloseTo(10 * 5e-6 + 20 * 8e-6, 12);
		expect(usage?.cost.output).toBeCloseTo(20 * 30e-6, 12);
		expect(usage?.cost.total).toBeCloseTo(10 * 5e-6 + 20 * 8e-6 + 20 * 30e-6, 12);
	});

	it("falls back to the text rate for image tokens when the model has no image rate", async () => {
		mockState.response = {
			...mockState.response,
			usage: { input_tokens: 30, input_tokens_details: { text_tokens: 10, image_tokens: 20 }, output_tokens: 0 },
		};
		const { imageInput: _omitted, ...cost } = model.cost;
		const usage = (await run({}, editContext, { ...model, cost })).usage;
		expect(usage?.cost.input).toBeCloseTo(30 * 5e-6, 12);
	});

	describe("rejects invalid combinations before any request", () => {
		it("transparent background needs png or webp", async () => {
			expect(await run({ background: "transparent", outputFormat: "jpeg" })).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringMatching(/transparent.*png or webp/i),
			});
			noRequests();
		});

		it("output_compression needs jpeg or webp", async () => {
			expect(await run({ outputCompression: 50 })).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringMatching(/output_compression.*jpeg or webp/i),
			});
			expect(await run({ outputCompression: 50, outputFormat: "png" })).toMatchObject({ stopReason: "error" });
			noRequests();
		});

		it.each([101, -1, 1.5, Number.NaN])("output_compression %s is out of range", async (outputCompression) => {
			expect(await run({ outputCompression, outputFormat: "webp" })).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringMatching(/output_compression.*0 and 100/i),
			});
			noRequests();
		});

		it.each([0, 100])("output_compression %s is accepted with webp", async (outputCompression) => {
			expect((await run({ outputCompression, outputFormat: "webp" })).stopReason).toBe("stop");
			expect(lastParams(mockState.generate)).toMatchObject({ output_compression: outputCompression });
		});

		it("a mask needs at least one input image", async () => {
			expect(await run({ mask })).toMatchObject({
				stopReason: "error",
				errorMessage: expect.stringMatching(/mask.*input image/i),
			});
			expect(mockState.toFile).not.toHaveBeenCalled();
			noRequests();
		});
	});
});
