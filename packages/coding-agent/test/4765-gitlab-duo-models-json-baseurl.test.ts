import { registerBuiltInApiProviders } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import registerGitLabDuo from "../examples/extensions/custom-provider-gitlab-duo/index.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	createRuntime,
	type ModelsJsonFile,
	modelsJsonFile,
	requireModel,
} from "./support/baseurl-override-fixture.ts";
import {
	type FetchGuard,
	installLoopbackFetchGuard,
	type LoopbackServer,
	startLoopbackServer,
} from "./support/loopback-network.ts";

const PROVIDER_ID = "gitlab-duo";
const DIRECT_ACCESS_URL = "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";

function gitLabDuoRegistration(): ProviderConfigInput {
	const registrations: ProviderConfigInput[] = [];
	const pi = {
		registerProvider: (_providerId: string, config: ProviderConfigInput) => registrations.push(config),
	} as unknown as ExtensionAPI;
	registerGitLabDuo(pi);
	const registration = registrations[0];
	if (!registration) throw new Error("gitlab-duo registered no provider");
	return registration;
}

/**
 * The direct-access token exchange stays on GitLab: it is authentication, not the model endpoint the
 * models.json baseUrl names. It is answered here so every other request still meets the loopback guard.
 */
function answerDirectAccessExchange(): void {
	const guarded = globalThis.fetch;
	vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : input.toString();
		if (url === DIRECT_ACCESS_URL) {
			return Promise.resolve(Response.json({ token: "direct-access-token", headers: { "x-gitlab-test": "1" } }));
		}
		return guarded(input, init);
	});
}

let server: LoopbackServer;
let guard: FetchGuard;
let models: ModelsJsonFile | undefined;

beforeAll(() => {
	registerBuiltInApiProviders();
});

beforeEach(async () => {
	vi.stubEnv("GITLAB_TOKEN", "glpat-test");
	server = await startLoopbackServer();
	guard = installLoopbackFetchGuard();
	answerDirectAccessExchange();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	models?.remove();
	models = undefined;
	await server.close();
});

async function sendOneTurn(baseUrl: string, modelId: string): Promise<void> {
	models = modelsJsonFile({ [PROVIDER_ID]: { baseUrl } });
	const runtime = await createRuntime(models.path);
	await runtime.registerProvider(PROVIDER_ID, gitLabDuoRegistration(), { refresh: false });
	await runtime.completeSimple(requireModel(runtime, PROVIDER_ID, modelId), {
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	});
}

describe("senpi#4765 gitlab-duo honors a models.json baseUrl", () => {
	it("sends an OpenAI-backend model's request to the models.json baseUrl instead of the GitLab AI gateway", async () => {
		await sendOneTurn(server.url, "gpt-5-codex");

		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/responses"]);
	});

	it("sends an Anthropic-backend model's request to the models.json baseUrl instead of the GitLab AI gateway", async () => {
		await sendOneTurn(new URL(server.url).origin, "claude-sonnet-4-6");

		expect(guard.blocked).toEqual([]);
		expect(server.requests).toEqual(["/v1/messages?beta=true"]);
	});
});
