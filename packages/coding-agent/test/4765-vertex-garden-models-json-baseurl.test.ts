import { registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerVertexModelGarden,
	VERTEX_MODEL_GARDEN_PROVIDER_ID,
} from "../src/core/extensions/builtin/vertex-model-garden/index.ts";
import type { ResolveVertexAccess } from "../src/core/extensions/builtin/vertex-model-garden/transport.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	createRuntime,
	type ModelsJsonFile,
	modelsJsonFile,
	requireModel,
} from "./support/baseurl-override-fixture.ts";
import { createGoogleAdcFixture } from "./support/google-adc-fixture.ts";
import {
	type FetchGuard,
	installLoopbackFetchGuard,
	type LoopbackServer,
	startLoopbackServer,
} from "./support/loopback-network.ts";

const access: ResolveVertexAccess = async () => ({
	accessToken: "adc-token",
	project: "proj-a",
	quotaProject: "quota-b",
});

function gardenRegistration(): ProviderConfigInput {
	const registrations: ProviderConfigInput[] = [];
	const pi = {
		registerProvider: (_providerId: string, config: ProviderConfigInput) => registrations.push(config),
	} as unknown as ExtensionAPI;
	registerVertexModelGarden(pi, access);
	const registration = registrations[0];
	if (!registration) throw new Error("vertex-garden registered no provider");
	return registration;
}

let adc: Awaited<ReturnType<typeof createGoogleAdcFixture>>;
let server: LoopbackServer;
let guard: FetchGuard;
let models: ModelsJsonFile | undefined;

beforeAll(async () => {
	registerBuiltInApiProviders();
	adc = await createGoogleAdcFixture({ quotaProjectId: "adc-quota-project" });
});

afterAll(async () => {
	await adc.close();
});

beforeEach(async () => {
	vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", adc.path);
	vi.stubEnv("GOOGLE_CLOUD_PROJECT", "adc-user-project");
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	models?.remove();
	models = undefined;
	await server.close();
});

describe("senpi#4765 vertex-garden honors a models.json baseUrl", () => {
	it("sends the chat request to the models.json baseUrl instead of the per-project Vertex endpoint", async () => {
		models = modelsJsonFile({ [VERTEX_MODEL_GARDEN_PROVIDER_ID]: { baseUrl: server.url } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider(VERTEX_MODEL_GARDEN_PROVIDER_ID, gardenRegistration(), { refresh: false });

		const reply = await runtime.completeSimple(
			requireModel(runtime, VERTEX_MODEL_GARDEN_PROVIDER_ID, "zai-org/glm-5.2-maas"),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		);

		expect(guard.blocked).toEqual([]);
		expect(reply.errorMessage).toBeUndefined();
		expect(server.requests).toEqual(["/v1/chat/completions"]);
	});
});
