import { describe, expect, it } from "vitest";
import { ELORIAN_MODELS } from "../src/providers/elorian.models.ts";
import { elorianProvider } from "../src/providers/elorian.ts";

// Public provider refresh contract: account limits must reach the catalog without
// losing the last usable catalog when a refresh fails or runs offline.
describe("Elorian account limits", () => {
	it("publishes the authenticated account limits rather than the offline defaults", async () => {
		let request: Request | undefined;
		const provider = elorianProvider({
			baseUrl: "https://elorian.test/v1/",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return Response.json({
					media: { context_tokens: 123_000 },
					output: { max_completion_tokens: 4_096 },
				});
			},
		});
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "elorian-test" },
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		expect(request?.url).toBe("https://elorian.test/v1/limits");
		expect(request?.headers.get("authorization")).toBe("Bearer elorian-test");
		expect(provider.getModels()[0]).toMatchObject({
			baseUrl: "https://elorian.test/v1",
			contextWindow: 123_000,
			maxTokens: 4_096,
		});
	});

	it.each([false, true])("retains stored limits with network allowed: %s", async (allowNetwork) => {
		const provider = elorianProvider({
			fetch: async () => Response.json({ error: { message: "unavailable" } }, { status: 503 }),
		});
		const storedModel = { ...ELORIAN_MODELS["elorian-1-agent"], contextWindow: 99_000, maxTokens: 2_048 };
		const refresh = provider.refreshModels?.({
			credential: { type: "api_key", key: "elorian-test" },
			allowNetwork,
			stored: { models: [storedModel], checkedAt: 1 },
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		if (allowNetwork) {
			await expect(refresh).rejects.toMatchObject({ status: 503 });
		} else {
			await refresh;
		}
		expect(provider.getModels()[0]).toEqual(storedModel);
	});

	it("rejects invalid account limits before publishing them", async () => {
		const provider = elorianProvider({
			fetch: async () => Response.json({ media: { context_tokens: 0 }, output: { max_completion_tokens: 8_000 } }),
		});
		const baseline = provider.getModels();
		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key", key: "elorian-test" },
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async (publication) => {
					publication.update?.();
					return true;
				},
			}),
		).rejects.toThrow();
		expect(provider.getModels()).toEqual(baseline);
	});
});
