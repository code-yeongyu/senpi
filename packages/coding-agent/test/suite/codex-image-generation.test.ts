import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImageGenAuthRegistry, resolveImageGenAuth } from "../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension, { IMAGE_GEN_SECTION } from "../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../src/core/extensions/builtin/imagegen/tool.ts";
import openaiImageGenExtension, {
	OPENAI_IMAGE_GEN_SECTION,
} from "../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { loadSkills } from "../../src/core/skills.ts";
import { createHarness, type Harness } from "./harness.ts";

const codex: Model<"openai-codex-responses"> = {
	id: "gpt-5.5",
	name: "Codex OAuth image fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};
const proxy: Model<"openai-codex-responses"> = {
	...codex,
	id: "codex-proxy-fixture",
	baseUrl: "https://codex-proxy.example.test/backend-api",
};
const optedOut: Model<"openai-codex-responses"> = {
	...codex,
	id: "codex-opt-out-fixture",
	compat: { supportsImageGeneration: false },
};
const oauthOnly: ImageGenAuthRegistry = {
	authStorage: { get: (provider) => (provider === "openai-codex" ? { type: "oauth" } : undefined) },
	getAll: () => [codex],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no image API key" }),
	getProviderAuth: async () => undefined,
};
const readTool = { type: "function", name: "read", parameters: { type: "object" } };
const clientTool = { type: "function", name: "generate_image", parameters: { type: "object" } };
const nativeTool = { type: "image_generation", model: "gpt-image-2.5-sunburst" };
const harnesses: Harness[] = [];

async function start(model: Model<Api> = codex, native = true): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: native ? [imageGenExtension, openaiImageGenExtension] : [imageGenExtension],
	});
	harnesses.push(harness);
	harness.modelRegistry.registerProvider(codex.provider, {
		api: codex.api,
		baseUrl: codex.baseUrl,
		apiKey: "offline-session-switch-fixture",
		models: [codex, proxy, optedOut],
	});
	harness.agent.state.model = model;
	await harness.session.bindExtensions({});
	return harness;
}

async function payload(harness: Harness): Promise<unknown> {
	return harness.getExtensionRunner().emitBeforeProviderRequest({
		model: harness.session.model?.id,
		tools: [clientTool, readTool, { type: "image_generation", model: "gpt-image-1" }],
	});
}

async function skillNames(harness: Harness): Promise<string[]> {
	const resources = await harness.getExtensionRunner().emitResourcesDiscover(harness.tempDir, "reload");
	const loaded = loadSkills({
		cwd: harness.tempDir,
		agentDir: join(harness.tempDir, "agent"),
		skillPaths: resources.skillPaths.map((entry) => entry.path),
		includeDefaults: false,
	});
	expect(loaded.diagnostics).toEqual([]);
	return loaded.skills.map((skill) => skill.name);
}

async function prompt(harness: Harness) {
	return harness.getExtensionRunner().emitBeforeAgentStart("draw a fox", undefined, "base", { cwd: harness.tempDir });
}

beforeEach(() => {
	vi.stubEnv("OPENAI_API_KEY", "");
	vi.stubEnv("PI_IMAGE_GEN_PROVIDER", "");
	vi.stubEnv("PI_OPENAI_IMAGE_GEN", "");
	setImageGenRegistry(oauthOnly);
	setNativeBypass(false);
});

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	setImageGenRegistry(undefined);
	setNativeBypass(false);
	vi.unstubAllEnvs();
});

describe("Codex OAuth image generation lifecycle", () => {
	it("automatically injects one pinned native tool and bypasses the client without changing transport", async () => {
		const harness = await start();
		expect((await resolveImageGenAuth({ modelRegistry: oauthOnly })).kind).toBe("none");
		expect(await payload(harness)).toEqual({ model: codex.id, tools: [readTool, nativeTool] });
		const result = await harness.session.executeTool<GenerateImageDetails>("generate_image", { prompt: "a fox" });
		expect(result.details.reason).toBe("provider_native_bypass");
		expect(harness.session.model).toEqual(codex);
		expect(await skillNames(harness)).toEqual(["gpt-image-gen"]);
		expect((await prompt(harness))?.systemPrompt).toBe(`base\n${IMAGE_GEN_SECTION}\n${OPENAI_IMAGE_GEN_SECTION}`);
	});

	it.each([
		["Codex OAuth", codex],
		["OpenAI Responses", { ...codex, api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
	] as const)(
		"contributes the bundled skill and shipped guidance with only native capability: %s",
		async (_label, model) => {
			const harness = await start(model, false);
			expect(await skillNames(harness)).toEqual(["gpt-image-gen"]);
			expect((await prompt(harness))?.systemPrompt).toBe(`base\n${IMAGE_GEN_SECTION}`);
		},
	);

	it.each([
		["proxy", proxy],
		["explicit opt-out", optedOut],
	] as const)(
		"removes native tooling and guidance when switching to %s without image credentials",
		async (_label, model) => {
			const harness = await start();
			expect(await payload(harness)).toEqual({ model: codex.id, tools: [readTool, nativeTool] });
			await harness.session.setModel(model);
			expect(await payload(harness)).toEqual({ model: model.id, tools: [readTool] });
			expect(await skillNames(harness)).toEqual([]);
			expect(await prompt(harness)).toBeUndefined();
			const result = await harness.session.executeTool<GenerateImageDetails>("generate_image", { prompt: "a fox" });
			expect(result.details.reason).toBe("missing_config");
		},
	);

	it("honors the global disable even with proxy opt-in", async () => {
		vi.stubEnv("PI_OPENAI_IMAGE_GEN", "off");
		const harness = await start({ ...proxy, compat: { supportsImageGeneration: true } });
		expect(await payload(harness)).toEqual({ model: proxy.id, tools: [readTool] });
		expect(await skillNames(harness)).toEqual([]);
		expect(await prompt(harness)).toBeUndefined();
	});

	it("keeps the client descriptor and skill when disabled native generation has gateway credentials", async () => {
		vi.stubEnv("PI_OPENAI_IMAGE_GEN", "0");
		setImageGenRegistry({
			...oauthOnly,
			getAll: () => [{ ...proxy, provider: "image-gateway-fixture", api: "openai-responses" }],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-image-gateway-fixture" }),
		});
		const harness = await start();
		expect(await payload(harness)).toEqual({ model: codex.id, tools: [clientTool, readTool] });
		expect(await skillNames(harness)).toEqual(["gpt-image-gen"]);
		expect((await prompt(harness))?.systemPrompt).toBe(`base\n${IMAGE_GEN_SECTION}`);
	});
});
