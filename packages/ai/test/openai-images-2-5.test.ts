import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateImages, type OpenAIImagesOptions, parseOpenAIImageSize } from "../src/api/openai-images.ts";
import type { ImageContent, ImagesContext, ImagesModel } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	generate: vi.fn(),
	edit: vi.fn(),
	toFile: vi.fn(
		async (bytes: Uint8Array, name: string, options: FilePropertyBag) =>
			new File([Uint8Array.from(bytes)], name, options),
	),
}));
vi.mock("openai", () => ({
	default: class FakeOpenAI {
		images = { generate: mockState.generate, edit: mockState.edit };
	},
	toFile: mockState.toFile,
}));

const image: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const model: ImagesModel<"openai-images"> = {
	id: "gpt-image-2.5-sunburst",
	name: "GPT Image 2.5 Sunburst",
	api: "openai-images",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text", "image"],
	output: ["image"],
	cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0 },
};
const context: ImagesContext = { input: [{ type: "text", text: "Draw a lighthouse" }] };
function run(options: OpenAIImagesOptions = {}, input = context, target = model) {
	return generateImages(target, input, { apiKey: "test-key", ...options });
}

describe("OpenAI GPT Image 2.5", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const response = () => ({
			withResponse: async () => ({
				data: {
					data: [{ b64_json: image.data }],
					usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
				},
				response: { status: 200, headers: new Headers({ "x-request-id": "edit-1" }) },
			}),
		});
		mockState.generate.mockImplementation(response);
		mockState.edit.mockImplementation(response);
	});

	it.each(["xhigh", "max"] as const)("passes quality %s through without gating older models", async (quality) => {
		for (const id of [model.id, "gpt-image-2.5-flare", "gpt-image-2"]) {
			expect((await run({ quality }, context, { ...model, id })).stopReason).toBe("stop");
			expect(mockState.generate).toHaveBeenLastCalledWith(
				expect.objectContaining({ quality, model: id }),
				expect.anything(),
			);
		}
	});

	it.each(["2048x1152", "3840x2160"] as const)("passes size %s to generations", async (size) => {
		expect((await run({ size })).stopReason).toBe("stop");
		expect(mockState.generate).toHaveBeenCalledWith(expect.objectContaining({ size }), expect.anything());
	});

	it.each([
		["1000x1000", /divisible by 16/i],
		["3840x1024", /aspect ratio/i],
		["4096x1024", /3840/],
		["512x512", /pixels/i],
	] as const)("rejects invalid size %s before any request", async (size, error) => {
		expect(await run({ size })).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(error) });
		expect(mockState.generate).not.toHaveBeenCalled();
		expect(mockState.edit).not.toHaveBeenCalled();
	});

	it("uploads reference images, joins the prompt, and shares hooks and usage", async () => {
		const onPayload = vi.fn((payload: unknown) => payload);
		const onResponse = vi.fn();
		const signal = new AbortController().signal;
		const result = await run(
			{ quality: "max", size: "3840x2160", n: 2, onPayload, onResponse, signal, timeoutMs: 1234 },
			{
				input: [context.input[0], image, { type: "text", text: "Make it blue" }],
			},
		);
		expect(result.stopReason).toBe("stop");
		expect(result.output).toEqual([image]);
		expect(result.usage).toMatchObject({ input: 10, output: 20, totalTokens: 30 });
		expect(result.usage?.cost.total).toBeCloseTo(0.00065);
		expect(mockState.generate).not.toHaveBeenCalled();
		expect(mockState.edit).toHaveBeenCalledOnce();
		const [params, options] = mockState.edit.mock.calls[0];
		expect(params).toMatchObject({
			model: model.id,
			prompt: "Draw a lighthouse\n\nMake it blue",
			quality: "max",
			size: "3840x2160",
			n: 2,
			output_format: "png",
		});
		expect(params).not.toHaveProperty("input_fidelity");
		expect(params.image).toHaveLength(1);
		expect(params.image[0]).toBeInstanceOf(File);
		expect(params.image[0].name).toBe("reference-0.png");
		expect(params.image[0].type).toBe("image/png");
		expect(Buffer.from(await params.image[0].arrayBuffer()).toString("base64")).toBe(image.data);
		expect(mockState.toFile).toHaveBeenCalledWith(Buffer.from(image.data, "base64"), "reference-0.png", {
			type: "image/png",
		});
		expect(options).toMatchObject({ signal, timeout: 1234, maxRetries: 0 });
		expect(onPayload).toHaveBeenCalledWith(params, model);
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "x-request-id": "edit-1" } }, model);
	});

	it("accepts 16 references in order and preserves MIME types", async () => {
		const references = Array.from({ length: 16 }, (_, i) => ({
			...image,
			mimeType: i % 2 ? "image/jpeg" : "image/webp",
		}));
		expect((await run({}, { input: [...context.input, ...references] })).stopReason).toBe("stop");
		const uploads: File[] = mockState.edit.mock.calls[0][0].image;
		expect(uploads).toHaveLength(16);
		expect(uploads[0]).toMatchObject({ name: "reference-0.webp", type: "image/webp" });
		expect(uploads[15]).toMatchObject({ name: "reference-15.jpeg", type: "image/jpeg" });
	});

	it("rejects 17 references without uploading or making a request", async () => {
		expect(await run({}, { input: [...context.input, ...Array.from({ length: 17 }, () => image)] })).toMatchObject({
			stopReason: "error",
			errorMessage: "OpenAI image edits accept at most 16 reference images",
		});
		expect(mockState.toFile).not.toHaveBeenCalled();
		expect(mockState.generate).not.toHaveBeenCalled();
		expect(mockState.edit).not.toHaveBeenCalled();
	});

	it("uses replacement edit payloads and rejects replacements without a string prompt", async () => {
		const input = { input: [...context.input, image] };
		const replacement = { prompt: "Hooked", model: "gpt-image-2.5-flare", image: [new File(["png"], "hook.png")] };
		expect((await run({ onPayload: () => replacement }, input)).stopReason).toBe("stop");
		expect(mockState.edit).toHaveBeenLastCalledWith(replacement, expect.anything());
		mockState.edit.mockClear();
		expect((await run({ onPayload: () => ({ prompt: 123 }) }, input)).stopReason).toBe("error");
		expect(mockState.edit).not.toHaveBeenCalled();
	});
});

describe("parseOpenAIImageSize", () => {
	it.each([
		"auto",
		"1024x1024",
		"1536x1024",
		"1024x1536",
		"2048x2048",
		"2048x1152",
		"3840x2160",
		"2160x3840",
		"640x1024",
		"768x2304",
		"2304x768",
	])("accepts %s", (size) => {
		expect(parseOpenAIImageSize(size)).toEqual({ ok: true, size });
	});
	it.each([
		["1024X1024", /WIDTHxHEIGHT/i],
		["1.5x1024", /WIDTHxHEIGHT/i],
		["-1024x1024", /WIDTHxHEIGHT/i],
		["1024x1024\n", /WIDTHxHEIGHT/i],
		["", /WIDTHxHEIGHT/i],
		["1000x1000", /divisible by 16/i],
		["3840x1024", /aspect ratio/i],
		["1024x3840", /aspect ratio/i],
		["4096x1024", /3840/],
		["512x512", /pixels/i],
		["3840x3840", /pixels/i],
		["0x0", /pixels/i],
	])("rejects %s with its violated rule", (size, error) => {
		expect(parseOpenAIImageSize(size)).toEqual({ ok: false, error: expect.stringMatching(error) });
	});
});
