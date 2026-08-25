import { complete, resetApiProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const requestState = vi.hoisted(() => ({ url: "", headers: new Headers() }));

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	requestState.url = String(input);
	requestState.headers = new Headers(init?.headers);
	return Promise.resolve(
		new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
}

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(model).toBeDefined();

		resetApiProviders();
		await modelRuntime.completeSimple(model!, { messages: [] }, { fetch: mockFetch });

		expect(requestState.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat/chat/completions",
		);
		expect(requestState.headers.get("cf-aig-authorization")).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");
		expect(model).toBeDefined();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		await complete(model!, { messages: [] }, { ...auth, fetch: mockFetch });

		expect(requestState.url).toBe(
			"https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat/chat/completions",
		);
		expect(requestState.headers.get("cf-aig-authorization")).toBe("Bearer test-token");
		expect(requestState.headers.get("Authorization")).toBeNull();
		expect(requestState.headers.get("x-api-key")).toBeNull();
	});
});
