/**
 * Truth-table regression: locks the three-consumer coherence invariant for the
 * image-generation arbitration across the full matrix of (credentials × model ×
 * enable-env). The three consumers — native injector (openai-image-gen), client
 * tool (imagegen), and skill contribution (imagegen) — must never disagree on
 * which image-generation surface is active for a given request.
 *
 * Built on the seams established by todos 4/5/10/11. The mutation proof (todo 12
 * acceptance) flips `supportsNativeOpenAiImageGeneration` to constant true and
 * verifies that the truth-table rows discriminating native-vs-client fail.
 */

import type { AssistantImages, ImagesContext, ImagesModel, Model, ProviderImagesOptions } from "@earendil-works/pi-ai";
import { registerImagesApiProvider, unregisterImagesApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ImageGenAuthRegistry } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import imageGenExtension, { IMAGE_GEN_SECTION } from "../../../src/core/extensions/builtin/imagegen/index.ts";
import { setImageGenRegistry, setNativeBypass } from "../../../src/core/extensions/builtin/imagegen/state.ts";
import type { GenerateImageDetails } from "../../../src/core/extensions/builtin/imagegen/tool.ts";
import { supportsNativeOpenAiImageGeneration } from "../../../src/core/extensions/builtin/openai-image-gen/gate.ts";
import openaiImageGenExtension, {
	OPENAI_IMAGE_GEN_SECTION,
} from "../../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// ── constants ───────────────────────────────────────────────────────────

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const ENABLE_ENV = "PI_OPENAI_IMAGE_GEN";
const STUB_SOURCE_ID = "openai-image-gen-arbitration-stub";
const GENERATE_IMAGE = "generate_image";
const NATIVE_TYPE = "image_generation";

const BASE_MODEL = {
	id: "gpt-5.5",
	name: "GPT-5.5",
	reasoning: false,
	input: ["text"] as ("text" | "image" | "video")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

// ── model fixtures ──────────────────────────────────────────────────────

/** Official OpenAI Responses endpoint — supports native image_generation. */
const officialOpenAi: Model<"openai-responses"> = {
	...BASE_MODEL,
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

/** Official endpoint with compat explicitly disabling native image gen. */
const officialCompatOff: Model<"openai-responses"> = {
	...officialOpenAi,
	compat: { supportsImageGeneration: false },
};

/** Proxied Responses endpoint — defaults to client tool. */
const proxiedOpenAi: Model<"openai-responses"> = {
	...BASE_MODEL,
	api: "openai-responses",
	provider: "quotio-openai",
	baseUrl: "https://gateway.example/openai/v1",
};

/** Proxied Responses with compat opt-in for native image gen. */
const proxiedCompatOn: Model<"openai-responses"> = {
	...proxiedOpenAi,
	compat: { supportsImageGeneration: true },
};

/** Azure Responses — defaults to client tool (unlike websearch). */
const azureResponses: Model<"azure-openai-responses"> = {
	...BASE_MODEL,
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://contoso.openai.azure.com/openai/v1",
};

/** Non-Responses API — native injection is always stripped. */
const completionsModel: Model<"openai-completions"> = {
	...BASE_MODEL,
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
};

// ── registry fixtures ───────────────────────────────────────────────────

/** No resolvable credentials. */
const emptyRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => undefined },
	getAll: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth" }),
	getProviderAuth: async () => undefined,
};

/** Gateway credentials resolvable (quotio-openai). */
const gatewayRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => undefined },
	getAll: () => [
		{
			provider: "quotio-openai",
			id: "gpt-5",
			baseUrl: "https://gateway.example/openai/v1",
			api: "openai-completions",
		},
	],
	getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "gateway-secret" }),
	getProviderAuth: async () => undefined,
};

/** Native OpenAI stored key resolvable. */
const nativeRegistry: ImageGenAuthRegistry = {
	authStorage: { get: () => ({ type: "api_key" }) },
	getAll: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no gateway" }),
	getProviderAuth: async () => ({ auth: { apiKey: "sk-native-test-key" } }),
};

// ── stub images provider ────────────────────────────────────────────────

interface StubController {
	calls: number;
}

function registerStubImagesProvider(): StubController {
	const controller = { calls: 0 };
	registerImagesApiProvider(
		{
			api: "openai-images" as const,
			async generateImages(
				model: ImagesModel<"openai-images">,
				_context: ImagesContext,
				_options?: ProviderImagesOptions,
			): Promise<AssistantImages> {
				controller.calls += 1;
				return {
					api: "openai-images",
					provider: model.provider,
					model: model.id,
					output: [{ type: "image", data: PNG_BASE64, mimeType: "image/png" }],
					stopReason: "stop",
					timestamp: Date.now(),
				};
			},
		},
		STUB_SOURCE_ID,
	);
	return controller;
}

// ── helpers ─────────────────────────────────────────────────────────────

interface PayloadTool {
	type?: string;
	name?: string;
}

function readTools(payload: unknown): PayloadTool[] {
	if (typeof payload !== "object" || payload === null || !("tools" in payload)) return [];
	const tools = payload.tools;
	if (!Array.isArray(tools)) return [];
	return tools.map((tool: unknown) => {
		if (typeof tool !== "object" || tool === null) return {};
		const type = "type" in tool && typeof tool.type === "string" ? tool.type : undefined;
		const name = "name" in tool && typeof tool.name === "string" ? tool.name : undefined;
		return { type, name };
	});
}

function hasFunctionTool(payload: unknown, name: string): boolean {
	return readTools(payload).some((tool) => tool.name === name);
}

function nativeImageCount(payload: unknown): number {
	return readTools(payload).filter((tool) => tool.type === NATIVE_TYPE).length;
}

function requestPayload(): Record<string, unknown> {
	return {
		model: "gpt-5.5",
		tools: [
			{ type: "function", name: GENERATE_IMAGE, parameters: { type: "object" } },
			{ type: "function", name: "read", parameters: { type: "object" } },
		],
	};
}

// ── truth-table row type ─────────────────────────────────────────────────

type CredDirection = "none" | "gateway" | "native";
type ModelDirection = "official" | "official-compat-off" | "proxied" | "proxied-compat-on" | "azure" | "completions";
type EnvDirection = "on" | "off";

interface Expected {
	/** Skill paths emitted by resources_discover. */
	skillPresent: boolean;
	/** IMAGE_GEN_SECTION (client) from imagegen before_agent_start. */
	clientSection: boolean;
	/** OPENAI_IMAGE_GEN_SECTION (native) from openai-image-gen before_agent_start. */
	nativeSection: boolean;
	/** Tool behavior: missing_config | live | bypass. */
	toolBehavior: "missing_config" | "live" | "provider_native_bypass";
	/** Native image_generation tool count in the request payload. */
	nativeInjection: number;
}

interface TruthRow {
	creds: CredDirection;
	model: ModelDirection;
	env: EnvDirection;
	expected: Expected;
	label: string;
}

const MODEL_MAP: Record<ModelDirection, Model<string>> = {
	official: officialOpenAi,
	"official-compat-off": officialCompatOff,
	proxied: proxiedOpenAi,
	"proxied-compat-on": proxiedCompatOn,
	azure: azureResponses,
	completions: completionsModel,
};

function registryFor(creds: CredDirection): ImageGenAuthRegistry {
	switch (creds) {
		case "none":
			return emptyRegistry;
		case "gateway":
			return gatewayRegistry;
		case "native":
			return nativeRegistry;
	}
}

// ── truth table ─────────────────────────────────────────────────────────
//
// The coherence invariant: for each row, the native injector, client tool, and
// skill must agree on the active image-generation surface.
//
// Native injection depends on: model (api=responses + official-or-compat) AND env=on.
// Client tool behavior depends on: nativeBypass (set by injector) or resolveImageGenAuth.
// Skill contribution depends on: resolveImageGenAuth != none.
//
// Coherence rules:
//   nativeInjection > 0  →  toolBehavior = bypass  AND  nativeSection = true
//   nativeInjection = 0  →  nativeSection = false
//   creds != none        →  skillPresent = true  AND  clientSection = true (when not native)
//   creds = none         →  skillPresent = false  AND  clientSection = false
//   creds = none + nativeInjection = 0  →  toolBehavior = missing_config
//   creds != none + nativeInjection = 0  →  toolBehavior = live

const TRUTH_TABLE: TruthRow[] = [
	// ── creds: none ───────────────────────────────────────────────────
	{
		creds: "none",
		model: "official",
		env: "on",
		label: "no creds, official endpoint, env on → native injection without client creds",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: true,
			toolBehavior: "provider_native_bypass",
			nativeInjection: 1,
		},
	},
	{
		creds: "none",
		model: "official",
		env: "off",
		label: "no creds, official endpoint, env off → unavailable",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
	{
		creds: "none",
		model: "proxied",
		env: "on",
		label: "no creds, proxied endpoint, env on → unavailable",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
	{
		creds: "none",
		model: "proxied",
		env: "off",
		label: "no creds, proxied endpoint, env off → unavailable",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
	{
		creds: "none",
		model: "completions",
		env: "on",
		label: "no creds, completions api, env on → unavailable, native stripped",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
	{
		creds: "none",
		model: "azure",
		env: "on",
		label: "no creds, azure responses, env on → unavailable (azure defaults false)",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},

	// ── creds: gateway ────────────────────────────────────────────────
	{
		creds: "gateway",
		model: "official",
		env: "on",
		label: "gateway creds, official endpoint, env on → native injection + bypass",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: true,
			toolBehavior: "provider_native_bypass",
			nativeInjection: 1,
		},
	},
	{
		creds: "gateway",
		model: "official",
		env: "off",
		label: "gateway creds, official endpoint, env off → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "gateway",
		model: "proxied",
		env: "on",
		label: "gateway creds, proxied endpoint, env on → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "gateway",
		model: "proxied",
		env: "off",
		label: "gateway creds, proxied endpoint, env off → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "gateway",
		model: "completions",
		env: "on",
		label: "gateway creds, completions api, env on → client tool live, native stripped",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "gateway",
		model: "azure",
		env: "on",
		label: "gateway creds, azure responses, env on → client tool live (azure defaults false)",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},

	// ── creds: native (stored OpenAI key) ──────────────────────────────
	{
		creds: "native",
		model: "official",
		env: "on",
		label: "native creds, official endpoint, env on → native injection + bypass",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: true,
			toolBehavior: "provider_native_bypass",
			nativeInjection: 1,
		},
	},
	{
		creds: "native",
		model: "official",
		env: "off",
		label: "native creds, official endpoint, env off → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "native",
		model: "proxied",
		env: "on",
		label: "native creds, proxied endpoint, env on → client tool live (proxied defaults client)",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "native",
		model: "proxied",
		env: "off",
		label: "native creds, proxied endpoint, env off → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "native",
		model: "completions",
		env: "on",
		label: "native creds, completions api, env on → client tool live, native stripped",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "native",
		model: "azure",
		env: "on",
		label: "native creds, azure responses, env on → client tool live (azure defaults false)",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},

	// ── compat flag rows ──────────────────────────────────────────────
	{
		creds: "gateway",
		model: "official-compat-off",
		env: "on",
		label: "gateway creds, official + compat false, env on → client tool live",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: false,
			toolBehavior: "live",
			nativeInjection: 0,
		},
	},
	{
		creds: "gateway",
		model: "proxied-compat-on",
		env: "on",
		label: "gateway creds, proxied + compat true, env on → native injection + bypass",
		expected: {
			skillPresent: true,
			clientSection: true,
			nativeSection: true,
			toolBehavior: "provider_native_bypass",
			nativeInjection: 1,
		},
	},
	{
		creds: "none",
		model: "proxied-compat-on",
		env: "on",
		label: "no creds, proxied + compat true, env on → native injection without client creds",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: true,
			toolBehavior: "provider_native_bypass",
			nativeInjection: 1,
		},
	},
	{
		creds: "none",
		model: "proxied-compat-on",
		env: "off",
		label: "no creds, proxied + compat true, env off → unavailable",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
	{
		creds: "none",
		model: "official-compat-off",
		env: "on",
		label: "no creds, official + compat false, env on → unavailable",
		expected: {
			skillPresent: false,
			clientSection: false,
			nativeSection: false,
			toolBehavior: "missing_config",
			nativeInjection: 0,
		},
	},
];

// ── session management ──────────────────────────────────────────────────

const harnesses: Harness[] = [];

interface SessionOptions {
	creds: CredDirection;
	model: Model<string>;
}

async function startSession(options: SessionOptions): Promise<Harness> {
	setImageGenRegistry(registryFor(options.creds));
	const harness = await createHarness({
		extensionFactories: [imageGenExtension, openaiImageGenExtension],
	});
	harnesses.push(harness);
	for (const provider of ["openai", "quotio-openai", "azure"]) {
		harness.modelRegistry.registerProvider(provider, {
			baseUrl: "https://api.openai.com/v1",
			apiKey: "test-key",
			api: "openai-responses",
			models: [{ ...BASE_MODEL, api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
		});
	}
	harness.agent.state.model = options.model;
	await harness.session.bindExtensions({});
	return harness;
}

async function getPayload(harness: Harness, payload: unknown = requestPayload()): Promise<unknown> {
	return harness.getExtensionRunner().emitBeforeProviderRequest(payload);
}

async function getSkillPaths(harness: Harness): Promise<string[]> {
	const result = await harness.getExtensionRunner().emitResourcesDiscover(harness.tempDir, "startup");
	return result.skillPaths.map((entry) => entry.path);
}

async function getSystemPrompt(harness: Harness): Promise<string> {
	const result = await harness
		.getExtensionRunner()
		.emitBeforeAgentStart("draw a fox", undefined, "base", { cwd: harness.tempDir });
	return result?.systemPrompt ?? "base";
}

// ── test suite ──────────────────────────────────────────────────────────

describe("imagegen arbitration truth table", () => {
	let stub: StubController;

	beforeEach(() => {
		delete process.env[ENABLE_ENV];
		setNativeBypass(false);
		setImageGenRegistry(undefined);
		stub = registerStubImagesProvider();
	});

	afterEach(() => {
		delete process.env[ENABLE_ENV];
		setNativeBypass(false);
		setImageGenRegistry(undefined);
		unregisterImagesApiProviders(STUB_SOURCE_ID);
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Generate one `it` per truth-table row.
	for (const row of TRUTH_TABLE) {
		const envSuffix = row.env === "on" ? "env-on" : "env-off";
		const title = `#${row.creds} creds, ${row.model} model, ${envSuffix} #when a full session runs #then ${row.label}`;

		it(title, async () => {
			if (row.env === "off") process.env[ENABLE_ENV] = "0";

			const model = MODEL_MAP[row.model];
			const harness = await startSession({ creds: row.creds, model });
			const exp = row.expected;

			// ── consumer 1: native injector (payload) ────────────────────
			const payload = await getPayload(harness);
			expect(nativeImageCount(payload), "native injection count must match").toBe(exp.nativeInjection);
			if (exp.nativeInjection > 0) {
				expect(hasFunctionTool(payload, GENERATE_IMAGE), "function tool must be stripped in native mode").toBe(
					false,
				);
			}

			// ── consumer 2: client tool behavior ────────────────────────
			const toolResult = await harness.session.executeTool<GenerateImageDetails>(GENERATE_IMAGE, {
				prompt: "a fox in the snow",
			});
			if (exp.toolBehavior === "live") {
				expect(toolResult.details.reason, "live tool has no reason").toBeUndefined();
				expect(stub.calls, "live tool must have called the images provider").toBeGreaterThan(0);
			} else {
				expect(toolResult.details.reason, "tool behavior must match expected").toBe(exp.toolBehavior);
				expect(stub.calls, "non-live tool must not call the images provider").toBe(0);
			}

			// ── consumer 3: skill contribution ──────────────────────────
			const skillPaths = await getSkillPaths(harness);
			expect(skillPaths.length > 0, "skill presence must match").toBe(exp.skillPresent);

			// ── prompt section coherence ────────────────────────────────
			const systemPrompt = await getSystemPrompt(harness);
			expect(systemPrompt.includes(IMAGE_GEN_SECTION.trim()), "client section presence must match").toBe(
				exp.clientSection,
			);
			expect(systemPrompt.includes(OPENAI_IMAGE_GEN_SECTION.trim()), "native section presence must match").toBe(
				exp.nativeSection,
			);

			// ── invariant: native injection and native section must agree ──
			const hasNative = exp.nativeInjection > 0;
			expect(exp.nativeSection, "native section implies native injection").toBe(hasNative);
			expect(exp.toolBehavior === "provider_native_bypass", "bypass implies native injection").toBe(hasNative);

			// (client and native sections CAN coexist when creds exist and native mode is active;
			// the imagegen section is conditional-safe text that applies regardless of which surface owns the request)
		});
	}

	// ── coherence invariant summary ─────────────────────────────────────

	describe("coherence invariant", () => {
		it("every truth-table row satisfies: native injection ⟺ bypass ⟺ native section", () => {
			for (const row of TRUTH_TABLE) {
				const exp = row.expected;
				const hasNative = exp.nativeInjection > 0;
				expect(exp.toolBehavior === "provider_native_bypass", `${row.label}: bypass ⟺ native injection`).toBe(
					hasNative,
				);
				expect(exp.nativeSection, `${row.label}: native section ⟺ native injection`).toBe(hasNative);
				expect(exp.clientSection, `${row.label}: client section ⟺ creds exist`).toBe(row.creds !== "none");
			}
		});

		it("every truth-table row satisfies: skill present ⟺ creds != none", () => {
			for (const row of TRUTH_TABLE) {
				const exp = row.expected;
				const hasCreds = row.creds !== "none";
				expect(exp.skillPresent, `${row.label}: skill presence ⟺ creds exist`).toBe(hasCreds);
			}
		});

		it("every truth-table row satisfies: no creds + no native → missing_config", () => {
			for (const row of TRUTH_TABLE) {
				const exp = row.expected;
				if (row.creds === "none" && exp.nativeInjection === 0) {
					expect(exp.toolBehavior, `${row.label}: no creds + no native → missing_config`).toBe("missing_config");
				}
			}
		});

		it("every truth-table row satisfies: creds exist + no native → live", () => {
			for (const row of TRUTH_TABLE) {
				const exp = row.expected;
				if (row.creds !== "none" && exp.nativeInjection === 0) {
					expect(exp.toolBehavior, `${row.label}: creds + no native → live`).toBe("live");
				}
			}
		});
	});

	// ── gate function direct checks (mutation target) ───────────────────

	describe("gate function discrimination", () => {
		it("supportsNativeOpenAiImageGeneration discriminates official from proxied", () => {
			expect(supportsNativeOpenAiImageGeneration(officialOpenAi)).toBe(true);
			expect(supportsNativeOpenAiImageGeneration(proxiedOpenAi)).toBe(false);
			expect(supportsNativeOpenAiImageGeneration(azureResponses)).toBe(false);
			expect(supportsNativeOpenAiImageGeneration(completionsModel)).toBe(false);
			expect(supportsNativeOpenAiImageGeneration(officialCompatOff)).toBe(false);
			expect(supportsNativeOpenAiImageGeneration(proxiedCompatOn)).toBe(true);
		});
	});
});
