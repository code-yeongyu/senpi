import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantImages, ImagesContext, ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai/compat";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImageGenRegistry, setNativeBypass } from "../src/core/extensions/builtin/imagegen/state.ts";
import { type GenerateImageDetails, generateImageTool } from "../src/core/extensions/builtin/imagegen/tool.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const STUB_SOURCE_ID = "imagegen-tool-output-options-stub";
const stub: { background: AssistantImages["background"]; mimeType: string | undefined } = {
	background: undefined,
	mimeType: undefined,
};
const generate = vi.fn(
	async (
		model: ImagesModel<"openai-images">,
		_context: ImagesContext,
		options?: ProviderImagesOptions,
	): Promise<AssistantImages> => ({
		api: "openai-images",
		provider: model.provider,
		model: model.id,
		output: Array.from(
			{ length: options && "n" in options && typeof options.n === "number" ? options.n : 1 },
			() => ({
				type: "image" as const,
				data: PNG_BASE64,
				mimeType: stub.mimeType ?? `image/${options?.outputFormat ?? "png"}`,
			}),
		),
		...(stub.background === undefined ? {} : { background: stub.background }),
		stopReason: "stop",
		timestamp: 0,
	}),
);

let harness: Harness;

beforeEach(async () => {
	vi.stubEnv("OPENAI_API_KEY", "");
	vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
	setNativeBypass(false);
	setImageGenRegistry({
		authStorage: { get: () => ({ type: "api_key", key: "imagegen-test-key" }) },
		getAll: () => [],
		getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
		getProviderAuth: async () => ({ auth: { apiKey: "imagegen-test-key" } }),
	});
	generate.mockClear();
	stub.background = undefined;
	stub.mimeType = undefined;
	registerImagesApiProvider({ api: "openai-images", generateImages: generate }, STUB_SOURCE_ID);
	harness = await createHarness({ extensionFactories: [(pi) => pi.registerTool(generateImageTool)] });
	await harness.session.bindExtensions({});
});

afterEach(() => {
	harness?.cleanup();
	setImageGenRegistry(undefined);
	setNativeBypass(false);
	unregisterImagesApiProviders(STUB_SOURCE_ID);
	vi.unstubAllEnvs();
});

function execute(params: Record<string, unknown>) {
	return harness.session.executeTool<GenerateImageDetails>("generate_image", params);
}
function providerOptions(): ProviderImagesOptions | undefined {
	return generate.mock.calls[0]?.[2];
}

describe("generate_image output options", () => {
	it("defaults to Sunburst and prices the request from the static catalog", async () => {
		const result = await execute({ prompt: "a red fox" });

		expect(generate.mock.calls[0]?.[0]).toMatchObject({
			id: "gpt-image-2.5-sunburst",
			cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0, imageInput: 8 },
		});
		expect(result.details.model).toBe("gpt-image-2.5-sunburst");
	});

	it("forwards background, format, compression, and moderation and labels the result with the format", async () => {
		const result = await execute({
			prompt: "a red fox",
			background: "opaque",
			output_format: "webp",
			output_compression: 60,
			moderation: "low",
			output_path: "art/fox.webp",
		});

		expect(providerOptions()).toMatchObject({
			background: "opaque",
			outputFormat: "webp",
			outputCompression: 60,
			moderation: "low",
		});
		expect(result.details).toMatchObject({ background: "opaque", outputFormat: "webp", paths: ["art/fox.webp"] });
		expect(result.content.find((block) => block.type === "image")).toMatchObject({ mimeType: "image/webp" });
		expect(existsSync(join(harness.tempDir, "art/fox.webp"))).toBe(true);
	});

	it("keeps the png defaults on the wire and in the details", async () => {
		const result = await execute({ prompt: "a red fox", output_path: "fox" });

		expect(providerOptions()).toMatchObject({ outputFormat: "png" });
		expect(providerOptions()).not.toHaveProperty("background");
		expect(providerOptions()).not.toHaveProperty("outputCompression");
		expect(providerOptions()).not.toHaveProperty("moderation");
		expect(result.details).toMatchObject({ outputFormat: "png", background: "auto", paths: ["fox.png"] });
		expect(result.details).not.toHaveProperty("transparentBackground");
	});

	it.each([
		["jpeg", "art/fox", "art/fox.jpg"],
		["jpeg", "art/fox.jpeg", "art/fox.jpeg"],
		["jpeg", "art/fox.JPG", "art/fox.JPG"],
		["webp", "art/fox", "art/fox.webp"],
	] as const)("derives the %s extension for output_path %s", async (output_format, output_path, expected) => {
		const result = await execute({ prompt: "a red fox", output_format, output_path });
		expect(result.details.paths).toEqual([expected]);
		expect(existsSync(join(harness.tempDir, expected))).toBe(true);
	});

	it("names an omitted output_path after the format", async () => {
		await execute({ prompt: "a red fox", output_format: "webp", n: 2 });
		const entries = readdirSync(join(harness.tempDir, "generated-images")).sort();
		expect(entries).toHaveLength(2);
		expect(entries.every((entry) => /-0[12]\.webp$/.test(entry))).toBe(true);
	});

	it.each([
		["fox.png", "webp"],
		["fox.jpg", "png"],
		["fox.webp", "jpeg"],
	] as const)("rejects output_path %s for output_format %s before any request", async (output_path, output_format) => {
		const result = await execute({ prompt: "a red fox", output_path, output_format });
		expect(result.details).toMatchObject({ reason: "invalid_params" });
		expect(result.details.error).toContain(`.${output_format === "jpeg" ? "jpg" : output_format}`);
		expect(generate).not.toHaveBeenCalled();
	});

	it.each([
		[{ background: "transparent", output_format: "jpeg" }, /transparent.*png or webp/i],
		[{ output_compression: 50 }, /output_compression.*jpeg or webp/i],
		[{ output_compression: 50, output_format: "png" }, /output_compression.*jpeg or webp/i],
	])("rejects %o before any request", async (params, message) => {
		const result = await execute({ prompt: "a red fox", ...params });
		expect(result.details).toMatchObject({ reason: "invalid_params", error: expect.stringMatching(message) });
		expect(generate).not.toHaveBeenCalled();
	});

	it("sends mask_image_path as the edit mask and requires a reference image", async () => {
		writeFileSync(join(harness.tempDir, "reference.png"), Buffer.from(PNG_BASE64, "base64"));
		writeFileSync(join(harness.tempDir, "mask.png"), Buffer.from(PNG_BASE64, "base64"));

		const result = await execute({
			prompt: "replace the sky",
			reference_image_paths: ["reference.png"],
			mask_image_path: "mask.png",
		});
		expect(result.details.generated).toBe(1);
		expect(providerOptions()?.mask).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(generate.mock.calls[0]?.[1].input).toHaveLength(2);

		generate.mockClear();
		const rejected = await execute({ prompt: "replace the sky", mask_image_path: "mask.png" });
		expect(rejected.details).toMatchObject({
			reason: "invalid_params",
			error: expect.stringMatching(/mask.*reference/i),
		});
		expect(generate).not.toHaveBeenCalled();
	});

	it("rejects a mask that is not a readable image", async () => {
		writeFileSync(join(harness.tempDir, "reference.png"), Buffer.from(PNG_BASE64, "base64"));
		writeFileSync(join(harness.tempDir, "mask.png"), "not a png");
		const result = await execute({
			prompt: "x",
			reference_image_paths: ["reference.png"],
			mask_image_path: "mask.png",
		});
		expect(result.details).toMatchObject({ reason: "invalid_params", error: expect.stringContaining("mask.png") });
		expect(generate).not.toHaveBeenCalled();
	});

	it("renames the file when the provider returns a different format than requested", async () => {
		stub.mimeType = "image/png";
		const result = await execute({ prompt: "a red fox", output_format: "webp", output_path: "art/fox.webp" });
		expect(result.details).toMatchObject({ paths: ["art/fox.png"], outputFormat: "png" });
		expect(existsSync(join(harness.tempDir, "art/fox.png"))).toBe(true);
		expect(existsSync(join(harness.tempDir, "art/fox.webp"))).toBe(false);
		expect(result.content.find((block) => block.type === "text")).toMatchObject({
			text: expect.stringContaining("returned png instead of the requested webp"),
		});
	});

	it("names the colliding renamed target and writes nothing when the provider changes the format", async () => {
		stub.mimeType = "image/png";
		writeFileSync(join(harness.tempDir, "fox-02.png"), "occupied");
		const result = await execute({ prompt: "a red fox", output_format: "webp", output_path: "fox.webp", n: 2 });
		expect(result.details).toMatchObject({ reason: "write_failed", error: expect.stringContaining("fox-02.png") });
		expect(existsSync(join(harness.tempDir, "fox-01.png"))).toBe(false);
		expect(existsSync(join(harness.tempDir, "fox-01.webp"))).toBe(false);
	});

	it("reports the provider's transparency verdict", async () => {
		stub.background = "transparent";
		const result = await execute({ prompt: "a sticker", background: "transparent", output_format: "webp" });
		expect(result.details).toMatchObject({ background: "transparent", transparentBackground: true });

		stub.background = "opaque";
		const opaque = await execute({ prompt: "a sticker", background: "auto" });
		expect(opaque.details.transparentBackground).toBe(false);
	});
});
