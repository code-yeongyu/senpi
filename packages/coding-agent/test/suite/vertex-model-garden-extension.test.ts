import "@earendil-works/pi-ai/compat";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	registerVertexModelGarden,
	VERTEX_MODEL_GARDEN_PROVIDER_ID,
} from "../../src/core/extensions/builtin/vertex-model-garden/index.ts";
import {
	defaultResolveVertexAccess,
	type ResolveVertexAccess,
	streamVertexModelGarden,
} from "../../src/core/extensions/builtin/vertex-model-garden/transport.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { defaultModelPerProvider, findInitialModel } from "../../src/core/model-resolver.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createGoogleAdcFixture } from "../support/google-adc-fixture.ts";

const access: ResolveVertexAccess = async () => ({
	accessToken: "adc-token",
	project: "proj-a",
	quotaProject: "quota-b",
});

const context = normalizeContext({
	messages: [{ role: "user", content: "read a.txt", timestamp: 0 }],
});

function model(api: Api, id: string, provider: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://aiplatform.googleapis.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} as Model<Api>;
}

function sse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function capturingFetch(response: () => Response, captured: Captured[]): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return response();
	}) as typeof globalThis.fetch;
}

describe("vertex-garden openai-compatible lane", () => {
	it("sends ADC bearer and quota project to the openapi endpoint and parses tool calls", async () => {
		const captured: Captured[] = [];
		const chunk = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
		const fetch = capturingFetch(
			() =>
				sse([
					chunk({
						id: "c1",
						object: "chat.completion.chunk",
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: { name: "read", arguments: '{"path":"a.txt"}' },
										},
									],
								},
							},
						],
					}),
					chunk({
						id: "c1",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
					}),
					"data: [DONE]\n\n",
				]),
			captured,
		);

		const result = await streamVertexModelGarden(
			model("openai-completions", "zai-org/glm-5.2-maas", "vertex-garden"),
			context,
			{ fetch },
			access,
		).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/proj-a/locations/global/endpoints/openapi/chat/completions",
		);
		expect(captured[0].headers.get("authorization")).toBe("Bearer adc-token");
		expect(captured[0].headers.get("x-goog-user-project")).toBe("quota-b");
		expect(captured[0].body.model).toBe("zai-org/glm-5.2-maas");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }),
		);
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(7);
	});
});

describe("vertex-garden ADC failures", () => {
	it("surfaces credential failures as a terminal error event instead of throwing", async () => {
		const failing: ResolveVertexAccess = async () => {
			throw new Error("Vertex AI requires a project ID.");
		};
		const result = await streamVertexModelGarden(
			model("openai-completions", "zai-org/glm-5.2-maas", "vertex-garden"),
			context,
			undefined,
			failing,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("requires a project ID");
	});
});

const MISSING_ADC_PATH = join(tmpdir(), "senpi-vertex-garden-missing-application-default-credentials.json");

/** Registration captured through the real extension factory. */
function gardenRegistration(): { providerId: string; config: ProviderConfigInput } {
	const registrations: Array<{ providerId: string; config: ProviderConfigInput }> = [];
	const pi = {
		registerProvider: (providerId: string, config: ProviderConfigInput) => registrations.push({ providerId, config }),
	} as unknown as ExtensionAPI;
	registerVertexModelGarden(pi);
	const registration = registrations[0];
	if (!registration) throw new Error("vertex-garden registered no provider");
	return registration;
}

/** A real runtime with the real extension registration and a settled availability pass. */
async function runtimeWithGarden(): Promise<ReturnType<typeof getModelRuntime>> {
	const runtime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
	const { providerId, config } = gardenRegistration();
	await runtime.registerProvider(providerId, config);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("vertex-garden ADC default resolver", () => {
	let fixture: Awaited<ReturnType<typeof createGoogleAdcFixture>>;

	beforeAll(async () => {
		fixture = await createGoogleAdcFixture({ quotaProjectId: "adc-quota-project" });
	});

	afterAll(async () => {
		await fixture.close();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("#given an ADC file and a named project #when the resolver runs #then the apiKey slot never becomes the project", async () => {
		const resolved = await defaultResolveVertexAccess({
			apiKey: "stored-secret-never-a-project",
			env: { GOOGLE_APPLICATION_CREDENTIALS: fixture.path, GOOGLE_CLOUD_PROJECT: "env-project" },
		});

		expect(resolved).toMatchObject({
			accessToken: "adc-access-token",
			project: "env-project",
			quotaProject: "adc-quota-project",
		});
	});

	it("#given an ADC file without a project env var #when the resolver runs #then the ADC quota project supplies the target project", async () => {
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", undefined);
		vi.stubEnv("GCLOUD_PROJECT", undefined);

		const resolved = await defaultResolveVertexAccess({
			env: { GOOGLE_APPLICATION_CREDENTIALS: fixture.path },
		});

		expect(resolved).toMatchObject({ project: "adc-quota-project", quotaProject: "adc-quota-project" });
	});
});

describe("vertex-garden registration and availability", () => {
	let fixture: Awaited<ReturnType<typeof createGoogleAdcFixture>>;

	beforeAll(async () => {
		fixture = await createGoogleAdcFixture({ quotaProjectId: "adc-quota-project" });
	});

	afterAll(async () => {
		await fixture.close();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("#given Vertex ADC #when the provider is registered #then it is available through ambient auth", async () => {
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", fixture.path);
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "adc-user-project");

		const runtime = await runtimeWithGarden();

		expect(runtime.getProviderAuthStatus(VERTEX_MODEL_GARDEN_PROVIDER_ID)).toMatchObject({
			configured: true,
			ambient: true,
		});
		expect(
			runtime
				.getAvailableSnapshot()
				.filter((available) => available.provider === VERTEX_MODEL_GARDEN_PROVIDER_ID)
				.map((available) => available.id),
		).toEqual(["deepseek-ai/deepseek-v4.1-flash-maas", "zai-org/glm-5.2-maas"]);
	});

	it("#given GOOGLE_CLOUD_PROJECT without ADC credentials #when the provider is registered #then it stays unavailable", async () => {
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", MISSING_ADC_PATH);
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "adc-user-project");

		const runtime = await runtimeWithGarden();

		expect(runtime.getProviderAuthStatus(VERTEX_MODEL_GARDEN_PROVIDER_ID)).toMatchObject({ configured: false });
		expect(
			runtime.getAvailableSnapshot().some((available) => available.provider === VERTEX_MODEL_GARDEN_PROVIDER_ID),
		).toBe(false);
	});
});

describe("vertex-garden automatic default selection", () => {
	let fixture: Awaited<ReturnType<typeof createGoogleAdcFixture>>;

	beforeAll(async () => {
		fixture = await createGoogleAdcFixture({ quotaProjectId: "adc-quota-project" });
	});

	afterAll(async () => {
		await fixture.close();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("#given only Vertex ADC, GOOGLE_CLOUD_PROJECT and a location #when no default is saved #then the automatic default stays unchanged", async () => {
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", fixture.path);
		vi.stubEnv("GOOGLE_CLOUD_PROJECT", "adc-user-project");
		vi.stubEnv("GOOGLE_CLOUD_LOCATION", "global");

		const runtime = await runtimeWithGarden();
		const available = runtime
			.getAvailableSnapshot()
			.filter(
				(available) =>
					available.provider === "google-vertex" || available.provider === VERTEX_MODEL_GARDEN_PROVIDER_ID,
			);
		expect(available.some((available) => available.provider === "google-vertex")).toBe(true);
		const selectionRuntime = {
			getAvailableSnapshot: () => available,
			getModel: (provider: string, modelId: string) =>
				available.find((available) => available.provider === provider && available.id === modelId),
			hasConfiguredAuth: (provider: string) => runtime.getProviderAuthStatus(provider).configured,
			getProviderAuthStatus: (provider: string) => runtime.getProviderAuthStatus(provider),
		} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: selectionRuntime });

		expect(result.model?.provider).toBe("google-vertex");
		expect(result.model?.id).toBe(defaultModelPerProvider["google-vertex"]);
		expect(result.provenance).toBe("provider-default");
	});
});
