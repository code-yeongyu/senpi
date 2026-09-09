import { closeSync, openSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantImages, ImagesContext, ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai/compat";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImageGenRegistry, setNativeBypass } from "../src/core/extensions/builtin/imagegen/state.ts";
import { type GenerateImageDetails, generateImageTool } from "../src/core/extensions/builtin/imagegen/tool.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const STUB_SOURCE_ID = "imagegen-tool-2-5-test-stub";
const generate = vi.fn(
	async (
		model: ImagesModel<"openai-images">,
		_context: ImagesContext,
		_options?: ProviderImagesOptions,
	): Promise<AssistantImages> => ({
		api: "openai-images",
		provider: model.provider,
		model: model.id,
		output: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
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

describe("generate_image GPT Image 2.5", () => {
	it("defaults to Sunburst and saves the returned PNG", async () => {
		const result = await execute({ prompt: "a red fox", output_path: "fox.png" });

		expect(generate.mock.calls[0]?.[0]).toMatchObject({
			id: "gpt-image-2.5-sunburst",
			name: "GPT Image 2.5 Sunburst",
			input: ["text", "image"],
		});
		expect(result.details.model).toBe("gpt-image-2.5-sunburst");
		expect(readFileSync(join(harness.tempDir, "fox.png"))).toEqual(Buffer.from(PNG_BASE64, "base64"));
	});

	it.each(["max", "xhigh"])("passes Flare, %s quality, and arbitrary size to the provider", async (quality) => {
		const result = await execute({ prompt: "a red fox", model: "gpt-image-2.5-flare", quality, size: "2048x1152" });

		expect(generate.mock.calls[0]?.[0]).toMatchObject({ id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare" });
		expect(generate.mock.calls[0]?.[2]).toMatchObject({ quality, size: "2048x1152" });
		expect(result.details).toMatchObject({ model: "gpt-image-2.5-flare", quality, size: "2048x1152" });
	});

	it("keeps the legacy model selectable and leaves tier compatibility to the API", async () => {
		const result = await execute({ prompt: "a red fox", model: "gpt-image-2", quality: "max" });

		expect(generate.mock.calls[0]?.[0]).toMatchObject({ id: "gpt-image-2", name: "GPT Image 2" });
		expect(generate.mock.calls[0]?.[2]?.quality).toBe("max");
		expect(result.details.model).toBe("gpt-image-2");
	});

	it.each(["1000x1000", "4096x2048", "512x512", "3840x3840", "3072x768"])(
		"rejects invalid size %s without calling the provider",
		async (size) => {
			const result = await execute({ prompt: "a red fox", model: "gpt-image-2.5-flare", size });

			expect(result.details).toMatchObject({ reason: "invalid_params", model: "gpt-image-2.5-flare" });
			expect(generate).not.toHaveBeenCalled();
		},
	);

	it.each(["2048x2048", "3840x2160", "2160x3840"])("accepts popular size %s", async (size) => {
		await execute({ prompt: "a red fox", size });
		expect(generate.mock.calls[0]?.[2]?.size).toBe(size);
	});

	it.each([false, true])("sends a local PNG after the text input (absolute path: %s)", async (absolute) => {
		const path = join(harness.tempDir, "reference.png");
		writeFileSync(path, Buffer.from(PNG_BASE64, "base64"));
		const result = await execute({
			prompt: "  the same fox wearing a blue scarf  ",
			reference_image_paths: [absolute ? path : "reference.png"],
		});

		expect(result.details.generated).toBe(1);
		expect(generate.mock.calls[0]?.[1].input).toEqual([
			{ type: "text", text: "the same fox wearing a blue scarf" },
			{ type: "image", data: PNG_BASE64, mimeType: "image/png" },
		]);
	});

	it("recognizes JPEG and WEBP magic bytes rather than filename extensions", async () => {
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
		const webp = Buffer.from("524946460400000057454250", "hex");
		writeFileSync(join(harness.tempDir, "first.dat"), jpeg);
		writeFileSync(join(harness.tempDir, "second.dat"), webp);
		await execute({ prompt: "combine these references", reference_image_paths: ["first.dat", "second.dat"] });

		expect(generate.mock.calls[0]?.[1].input.slice(1)).toEqual([
			{ type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" },
			{ type: "image", data: webp.toString("base64"), mimeType: "image/webp" },
		]);
	});

	it.each([0, 6])("rejects %i references in both the schema and execute boundary", async (count) => {
		const params = {
			prompt: "a red fox",
			reference_image_paths: Array.from({ length: count }, (_, i) => `${i}.png`),
		};
		await expect(execute(params)).rejects.toMatchObject({ code: "invalid_params" });
		const result = await generateImageTool.execute(
			"reference-count",
			params,
			undefined,
			undefined,
			harness.getExtensionRunner().createContext(),
		);

		expect(result.details.reason).toBe("invalid_params");
		expect(generate).not.toHaveBeenCalled();
	});

	it("accepts five references in order", async () => {
		writeFileSync(join(harness.tempDir, "reference.png"), Buffer.from(PNG_BASE64, "base64"));
		await execute({ prompt: "a red fox", reference_image_paths: Array(5).fill("reference.png") });
		expect(generate.mock.calls[0]?.[1].input).toHaveLength(6);
	});

	it.each(["missing.png", ".", "not-an-image.png", "fake.webp", "large.png"])(
		"rejects invalid reference %s and names it without calling the provider",
		async (path) => {
			writeFileSync(join(harness.tempDir, "not-an-image.png"), "plain text, not a PNG");
			writeFileSync(join(harness.tempDir, "fake.webp"), Buffer.from("d2c9c6c604000000d7c5c2d0", "hex"));
			const oversized = join(harness.tempDir, "large.png");
			closeSync(openSync(oversized, "w"));
			truncateSync(oversized, 50 * 1024 * 1024 + 1);
			const result = await execute({ prompt: "a red fox", reference_image_paths: [path] });

			expect(result.details.reason).toBe("invalid_params");
			expect(result.details.error).toContain(path);
			expect(generate).not.toHaveBeenCalled();
		},
	);
});
