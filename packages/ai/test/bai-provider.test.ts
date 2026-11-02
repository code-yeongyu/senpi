import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { BAI_MODELS } from "../src/providers/bai.models.ts";
import { baiProvider } from "../src/providers/bai.ts";
import type { Model } from "../src/types.ts";

const neverAbortedSignal = new AbortController().signal;

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

describe("B.AI provider", () => {
	it("logs in with an API key and resolves stored credentials before the environment", async () => {
		const auth = baiProvider().auth.apiKey;
		expect(auth?.name).toBe("B.AI API key");

		const credential = await auth?.login?.({
			signal: neverAbortedSignal,
			notify: () => {},
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "bai-stored-key";
			},
		});
		expect(credential).toEqual({ type: "api_key", key: "bai-stored-key" });

		expect(
			await auth?.resolve({
				ctx: fakeAuthContext({ BAI_API_KEY: "bai-environment-key" }),
				credential,
				signal: neverAbortedSignal,
			}),
		).toEqual({
			auth: { apiKey: "bai-stored-key" },
			source: "stored credential",
		});

		expect(
			await auth?.resolve({
				ctx: fakeAuthContext({ BAI_API_KEY: "bai-environment-key" }),
				signal: neverAbortedSignal,
			}),
		).toEqual({
			auth: { apiKey: "bai-environment-key" },
			source: "BAI_API_KEY",
		});
	});

	it("discovers the credential-scoped catalog and keeps only classified chat models", async () => {
		const baseline = [
			{
				id: "gpt-5.6-sol",
				name: "GPT-5.6 Sol",
				api: "openai-responses",
				provider: "bai",
				baseUrl: "https://api.b.ai/v1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
				contextWindow: 1_050_000,
				maxTokens: 128_000,
			},
			{
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				api: "anthropic-messages",
				provider: "bai",
				baseUrl: "https://api.b.ai",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				contextWindow: 1_000_000,
				maxTokens: 128_000,
			},
		] satisfies Model<"openai-responses" | "anthropic-messages">[];
		let observedRequest: Request | undefined;
		const provider = baiProvider({
			models: baseline,
			fetch: async (input, init) => {
				observedRequest = new Request(input, init);
				return Response.json({
					object: "list",
					success: true,
					data: [
						{ id: "gpt-5.6-sol", object: "model", created: 1 },
						{ id: "unclassified-preview", object: "model", created: 2 },
					],
				});
			},
		});

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "bai-test-key" },
			allowNetwork: true,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		expect(observedRequest?.url).toBe("https://api.b.ai/v1/models");
		expect(observedRequest?.headers.get("authorization")).toBe("Bearer bai-test-key");
		expect(provider.getModels().map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
		expect(provider.getModels()[0]).toEqual(baseline[0]);
	});

	it("remaps cached model IDs to current B.AI metadata before network refresh", async () => {
		const provider = baiProvider();
		const stale = {
			...provider.getModels()[0],
			id: "gpt-5.6-sol",
			name: "gpt-5.6-sol",
			api: "openai-responses" as const,
			provider: "bai",
			baseUrl: "https://api.b.ai/v1",
			reasoning: true,
			input: ["text"] as Array<"text" | "image" | "video">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};

		await provider.refreshModels?.({
			stored: { models: [stale], checkedAt: 1 },
			allowNetwork: false,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		expect(provider.getModels()[0]).toMatchObject({
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
			contextWindow: 922_000,
			maxTokens: 128_000,
		});
	});

	it("applies a custom gateway URL to discovered OpenAI and Anthropic models", async () => {
		const catalog = [BAI_MODELS["gpt-5.6-sol"], BAI_MODELS["claude-sonnet-5"]] satisfies Model<
			"openai-responses" | "anthropic-messages"
		>[];
		const provider = baiProvider({
			baseUrl: "https://staging.b.ai/v1/",
			models: catalog,
			fetch: async () => Response.json({ data: catalog.map(({ id }) => ({ id })) }),
		});

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "bai-test-key" },
			allowNetwork: true,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		expect(provider.getModels().map((model) => model.baseUrl)).toEqual([
			"https://staging.b.ai/v1",
			"https://staging.b.ai",
		]);
	});

	it("resolves a discovered hyphenated Claude alias to its catalog entry", async () => {
		const provider = baiProvider({
			fetch: async () => Response.json({ data: [{ id: "claude-fable-5-1" }, { id: "gpt-5-6-sol" }] }),
		});

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "bai-test-key" },
			allowNetwork: true,
			signal: neverAbortedSignal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});

		expect(
			provider
				.getModels()
				.map((model) => model.id)
				.sort(),
		).toEqual(["claude-fable-5.1", "gpt-5.6-sol"]);
	});

	it("fails the refresh when B.AI reports the model list as unsuccessful", async () => {
		const provider = baiProvider({
			fetch: async () => Response.json({ object: "list", success: false, message: "key disabled", data: [] }),
		});

		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key", key: "bai-test-key" },
				allowNetwork: true,
				signal: neverAbortedSignal,
				publish: async (publication) => {
					publication.update?.();
					return true;
				},
			}),
		).rejects.toThrow("key disabled");
		expect(provider.getModels()).toEqual([]);
	});
});
