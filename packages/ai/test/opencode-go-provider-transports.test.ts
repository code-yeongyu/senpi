import { afterEach, describe, expect, it, vi } from "vitest";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("opencode-go provider transports", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("has a stream implementation for the API of every model in its catalog", async () => {
		// Given: the shipped catalog, and no network, so every request ends in an error event.
		vi.stubGlobal("fetch", async () => {
			throw new Error("network disabled in this test");
		});
		const provider = opencodeGoProvider();
		const oneModelPerApi = new Map(provider.getModels().map((model) => [model.api, model]));
		expect(oneModelPerApi.size).toBeGreaterThan(0);

		// When: one model of each API is streamed.
		const missing: string[] = [];
		for (const [api, model] of oneModelPerApi) {
			const result = await provider
				.stream(model, normalizeContext({ messages: [] }), { apiKey: "test-key", signal: AbortSignal.abort() })
				.result();
			if (result.errorMessage?.includes("has no API implementation")) missing.push(api);
		}

		// Then: no catalog API lacks a transport (a catalog refresh that adds an API group fails here).
		expect(missing).toEqual([]);
	});
});
