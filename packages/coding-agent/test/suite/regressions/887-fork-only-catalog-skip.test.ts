import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { allowNetwork } from "../../test-network-env.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/887.

const FORK_ONLY_PROVIDERS = ["alibaba-token-plan", "opengateway"] as const;
const UPSTREAM_SERVED_PROVIDER = "anthropic";

function catalog500(): Response {
	return new Response("catalog unavailable", { status: 500 });
}

function fetchedProviderIds(calls: Parameters<typeof fetch>[]): string[] {
	return calls.map((call) => {
		const url = new URL(String(call[0]));
		return decodeURIComponent(url.pathname.replace(/^\/api\/models\/providers\//, ""));
	});
}

async function createRuntime(catalogBaseUrl?: string): Promise<ModelRuntime> {
	const credentials = new InMemoryCredentialStore();
	for (const providerId of [...FORK_ONLY_PROVIDERS, UPSTREAM_SERVED_PROVIDER]) {
		await credentials.modify(providerId, async () => ({ type: "api_key", key: "test-key" }));
	}
	return ModelRuntime.create({
		credentials,
		modelsPath: null,
		allowModelNetwork: true,
		refreshOnCreate: false,
		modelRefreshTimeoutMs: 5_000,
		...(catalogBaseUrl === undefined ? {} : { catalogBaseUrl }),
	});
}

afterEach(() => vi.restoreAllMocks());

describe("fork-only builtin providers and the pi.dev catalog overlay (#887)", () => {
	it("skips the remote-catalog fetch for fork-only providers under the default catalog base URL", async () => {
		allowNetwork();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalog500());
		const runtime = await createRuntime();

		const result = await runtime.refresh({ allowNetwork: true });

		const fetched = fetchedProviderIds(fetchSpy.mock.calls);
		for (const providerId of FORK_ONLY_PROVIDERS) {
			expect(fetched, `no catalog fetch expected for ${providerId}`).not.toContain(providerId);
			expect(result.errors.has(providerId), `no refresh error expected for ${providerId}`).toBe(false);
		}
		expect(fetched).toContain(UPSTREAM_SERVED_PROVIDER);
		expect(result.errors.has(UPSTREAM_SERVED_PROVIDER)).toBe(true);
	});

	it("keeps the remote-catalog wrap for fork-only providers when a custom catalog base URL is configured", async () => {
		allowNetwork();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalog500());
		const runtime = await createRuntime("http://127.0.0.1:1");

		await runtime.refresh({ allowNetwork: true });

		const fetched = fetchedProviderIds(fetchSpy.mock.calls);
		for (const providerId of FORK_ONLY_PROVIDERS) {
			expect(fetched, `custom catalog base URL must still fetch ${providerId}`).toContain(providerId);
		}
	});
});
