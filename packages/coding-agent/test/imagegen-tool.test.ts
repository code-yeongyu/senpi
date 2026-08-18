import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantImages, ImagesContext, ImagesModel, ProviderImagesOptions } from "@earendil-works/pi-ai/compat";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setImageGenRegistry, setNativeBypass } from "../src/core/extensions/builtin/imagegen/state.ts";
import { generateImageTool } from "../src/core/extensions/builtin/imagegen/tool.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "generate_image";
const STUB_SOURCE_ID = "imagegen-tool-test-stub";

interface StubCall {
	model: ImagesModel<"openai-images">;
	context: ImagesContext;
	options: ProviderImagesOptions | undefined;
}

interface StubController {
	calls: StubCall[];
	setImages(count: number): void;
	setRevisedPrompts(prompts: string[]): void;
	setUsage(usage: AssistantImages["usage"]): void;
	fail(message: string): void;
}

const harnesses: Harness[] = [];

function registerStubImagesProvider(): StubController {
	const controller = {
		calls: [] as StubCall[],
		images: 1,
		revisedPrompts: [] as string[],
		usage: undefined as AssistantImages["usage"],
		error: undefined as string | undefined,
	};

	registerImagesApiProvider(
		{
			api: "openai-images" as const,
			async generateImages(
				model: ImagesModel<"openai-images">,
				context: ImagesContext,
				options?: ProviderImagesOptions,
			): Promise<AssistantImages> {
				controller.calls.push({ model, context, options });
				const base: AssistantImages = {
					api: "openai-images",
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: "stop",
					timestamp: Date.now(),
				};
				if (controller.error !== undefined) {
					return { ...base, stopReason: "error", errorMessage: controller.error };
				}
				const output: AssistantImages["output"] = [];
				for (let index = 0; index < controller.images; index++) {
					const revised = controller.revisedPrompts[index];
					if (revised !== undefined) output.push({ type: "text", text: revised });
					output.push({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
				}
				return { ...base, output, ...(controller.usage ? { usage: controller.usage } : {}) };
			},
		},
		STUB_SOURCE_ID,
	);

	return {
		calls: controller.calls,
		setImages(count: number) {
			controller.images = count;
		},
		setRevisedPrompts(prompts: string[]) {
			controller.revisedPrompts = prompts;
		},
		setUsage(usage: AssistantImages["usage"]) {
			controller.usage = usage;
		},
		fail(message: string) {
			controller.error = message;
		},
	};
}

interface ToolHarnessOptions {
	gateway?: boolean;
}

async function createToolHarness(options: ToolHarnessOptions = {}): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.registerTool(generateImageTool);
			},
		],
	});
	harnesses.push(harness);
	if (options.gateway) {
		harness.modelRegistry.registerProvider("quotio-openai", {
			baseUrl: "https://gateway.example/openai/v1",
			apiKey: "gateway-secret",
			api: "openai-completions",
			models: [
				{
					id: "gpt-5",
					name: "GPT-5",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 16_384,
					baseUrl: "https://gateway.example/openai/v1",
				},
			],
		});
	}
	await harness.session.bindExtensions({});
	return harness;
}

interface ImageDetails {
	paths: string[];
	model: string;
	source: string;
	size: string;
	quality: string;
	requested: number;
	generated: number;
	revisedPrompts: string[];
	error?: string;
	reason?: string;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function imageBlocks(result: { content: Array<{ type: string }> }): Array<{ type: string }> {
	return result.content.filter((block) => block.type === "image");
}

describe("generate_image tool", () => {
	let stub: StubController;

	beforeEach(() => {
		stub = registerStubImagesProvider();
		setNativeBypass(false);
		setImageGenRegistry(undefined);
	});

	afterEach(() => {
		setNativeBypass(false);
		setImageGenRegistry(undefined);
		unregisterImagesApiProviders(STUB_SOURCE_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("saves a generated image, reports its path, and records revised prompts", async () => {
		const harness = await createToolHarness({ gateway: true });
		stub.setRevisedPrompts(["A richly detailed red fox"]);
		stub.setUsage({
			input: 12,
			output: 34,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 46,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		});

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.png",
		});

		const absolute = join(harness.tempDir, "art/fox.png");
		expect(existsSync(absolute)).toBe(true);
		expect(readFileSync(absolute).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		expect(result.details.paths).toEqual(["art/fox.png"]);
		expect(result.details.revisedPrompts).toEqual(["A richly detailed red fox"]);
		expect(result.details.model).toBe("gpt-image-2");
		expect(result.details.requested).toBe(1);
		expect(result.details.generated).toBe(1);
		expect(result.details.size).toBe("auto");
		expect(result.details.quality).toBe("auto");
		expect(resultText(result)).toContain("art/fox.png");
		expect(imageBlocks(result)).toHaveLength(1);
		expect(result.usage?.totalTokens).toBe(46);
	});

	it("defaults an omitted output path to a sanitized generated-images file", async () => {
		const harness = await createToolHarness({ gateway: true });

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "a blue whale" });

		const generatedDir = join(harness.tempDir, "generated-images");
		const entries = readdirSync(generatedDir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatch(/^[A-Za-z0-9_-]{1,64}\.png$/);
		expect(result.details.paths).toEqual([`generated-images/${entries[0]}`]);
	});

	// The builtin provider catalog always contains credential-resolvable gateways (for
	// example github-copilot authenticates with static headers and no API key), so the
	// ambient session registry is never credential-free. The registry seam forces the
	// uncredentialed direction so this test is hermetic.
	it("returns structured missing_config guidance without throwing when no credentials resolve", async () => {
		const harness = await createToolHarness();
		setImageGenRegistry({
			authStorage: { get: () => undefined },
			getAll: () => [],
			getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
			getProviderAuth: async () => undefined,
		});

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "a red fox" });

		expect(result.details.reason).toBe("missing_config");
		expect(resultText(result)).toContain("openai");
		expect(resultText(result)).toContain("PI_IMAGE_GEN_PROVIDER");
		expect(resultText(result)).toContain("OPENAI_API_KEY");
		expect(stub.calls).toHaveLength(0);
	});

	it("threads gateway base url, provider id, and key through options instead of the environment", async () => {
		const harness = await createToolHarness({ gateway: true });

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			size: "1024x1536",
			quality: "high",
		});

		const call = stub.calls[0];
		expect(call?.model.baseUrl).toBe("https://gateway.example/openai/v1");
		expect(call?.model.provider).toBe("quotio-openai");
		expect(call?.model.api).toBe("openai-images");
		expect(call?.model.id).toBe("gpt-image-2");
		expect(call?.options?.apiKey).toBe("gateway-secret");
		expect(call?.options?.size).toBe("1024x1536");
		expect(call?.options?.quality).toBe("high");
		expect(call?.options?.n).toBe(1);
		expect(result.details.source).toBe("provider-config:quotio-openai");
		expect(JSON.stringify(result.details)).not.toContain("gateway-secret");
	});

	it("rejects a blank prompt and a non-png output extension before calling the provider", async () => {
		const harness = await createToolHarness({ gateway: true });

		const blank = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "   " });
		const wrongExtension = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.jpg",
		});

		expect(resultText(blank)).toContain("prompt");
		expect(resultText(wrongExtension)).toContain(".png");
		expect(stub.calls).toHaveLength(0);
	});

	it("appends a png extension to an extensionless output path", async () => {
		const harness = await createToolHarness({ gateway: true });

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox",
		});

		expect(result.details.paths).toEqual(["art/fox.png"]);
		expect(existsSync(join(harness.tempDir, "art/fox.png"))).toBe(true);
	});

	it("indexes multiple images before the png extension", async () => {
		const harness = await createToolHarness({ gateway: true });
		stub.setImages(2);

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.png",
			n: 2,
		});

		expect(result.details.paths).toEqual(["art/fox-01.png", "art/fox-02.png"]);
		expect(existsSync(join(harness.tempDir, "art/fox-01.png"))).toBe(true);
		expect(existsSync(join(harness.tempDir, "art/fox-02.png"))).toBe(true);
		expect(imageBlocks(result)).toHaveLength(2);
		expect(stub.calls[0]?.options?.n).toBe(2);
	});

	it("never overwrites an existing file", async () => {
		const harness = await createToolHarness({ gateway: true });
		mkdirSync(join(harness.tempDir, "art"), { recursive: true });
		writeFileSync(join(harness.tempDir, "art/fox.png"), "original");

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.png",
		});

		expect(resultText(result)).toContain("art/fox.png");
		expect(readFileSync(join(harness.tempDir, "art/fox.png"), "utf8")).toBe("original");
		expect(stub.calls).toHaveLength(0);
	});

	it("removes this invocation's files when a later write fails", async () => {
		const harness = await createToolHarness({ gateway: true });
		stub.setImages(2);
		// A dangling symlink passes the existsSync preflight (it resolves to nothing) but
		// fails the exclusive create, so the second write fails after the first succeeded.
		mkdirSync(join(harness.tempDir, "art"), { recursive: true });
		symlinkSync(join(harness.tempDir, "art/missing-target"), join(harness.tempDir, "art/fox-02.png"));

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.png",
			n: 2,
		});

		expect(existsSync(join(harness.tempDir, "art/fox-01.png"))).toBe(false);
		expect(resultText(result).toLowerCase()).toContain("failed");
		expect(result.details.paths).toEqual([]);
	});

	it("defers to the native server tool when the bypass seam is enabled", async () => {
		const harness = await createToolHarness({ gateway: true });
		setNativeBypass(true);

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, { prompt: "a red fox" });

		expect(result.details.reason).toBe("provider_native_bypass");
		expect(stub.calls).toHaveLength(0);
	});

	it("reports a provider failure without writing files", async () => {
		const harness = await createToolHarness({ gateway: true });
		stub.fail("upstream refused the request");

		const result = await harness.session.executeTool<ImageDetails>(TOOL_NAME, {
			prompt: "a red fox",
			output_path: "art/fox.png",
		});

		expect(resultText(result)).toContain("upstream refused the request");
		expect(existsSync(join(harness.tempDir, "art/fox.png"))).toBe(false);
		expect(result.details.paths).toEqual([]);
	});
});
