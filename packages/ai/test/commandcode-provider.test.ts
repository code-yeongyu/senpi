import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { builtinProviders, getBuiltinModel } from "../src/providers/all.ts";
import { commandCodeProvider } from "../src/providers/commandcode.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Command Code provider", () => {
	it("ships the generated catalog on both wires", () => {
		expect(builtinProviders().map((provider) => provider.id)).toContain("commandcode");
		expect(getBuiltinModel("commandcode", "claude-sonnet-5-5")).toMatchObject({
			api: "anthropic-messages",
			// The Anthropic SDK appends /v1/messages.
			baseUrl: "https://api.commandcode.ai/provider",
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		});
		expect(getBuiltinModel("commandcode", "deepseek/deepseek-v4-pro")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
		});
		// Vendor prefixes are part of the id and survive generation.
		expect(getBuiltinModel("commandcode", "MiniMaxAI/MiniMax-M2.7")?.id).toBe("MiniMaxAI/MiniMax-M2.7");
	});

	it("refreshes from /models, strips the plan namespace and follows the published endpoints", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					data: [
						{
							id: "commandcode-goat-plan/claude-sonnet-5-5",
							name: "Claude Sonnet 5.5 (Goat)",
							context_length: 1000000,
							supported_endpoints: ["/messages"],
						},
						{
							id: "fresh-model",
							name: "Fresh Model",
							context_length: 64000,
							supported_endpoints: ["/chat/completions", "/responses"],
						},
						{ id: "responses-only", supported_endpoints: ["/responses"] },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("commandcode", async () => ({ type: "api_key", key: "cmd-key" }));
		const models = createModels({ credentials });
		models.setProvider(commandCodeProvider());

		const result = await models.refresh({ providers: ["commandcode"] });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.commandcode.ai/provider/v1/models",
			expect.objectContaining({ headers: { accept: "application/json" } }),
		);
		expect(result.errors).toEqual(new Map());
		// Baseline cost and reasoning survive a refreshed row whose id was namespaced by the plan.
		expect(models.getModel("commandcode", "claude-sonnet-5-5")).toMatchObject({
			name: "Claude Sonnet 5.5 (Goat)",
			api: "anthropic-messages",
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1000000,
		});
		expect(models.getModel("commandcode", "commandcode-goat-plan/claude-sonnet-5-5")).toBeUndefined();
		// A row the baseline does not know is unpriced, not free, and keeps a conservative output cap.
		expect(models.getModel("commandcode", "fresh-model")).toMatchObject({
			api: "openai-completions",
			maxTokens: 32000,
			cost: { unknown: true },
		});
		// /models is the plan's own catalog: a baseline model it does not list is not reachable on this key.
		expect(models.getModel("commandcode", "MiniMaxAI/MiniMax-M2.7")).toBeUndefined();
		// /models lists a model with no supported chat wire here; it is not selectable.
		expect(models.getModel("commandcode", "responses-only")).toBeUndefined();
	});

	it("reads CMD_API_KEY first and accepts the descriptive alias", () => {
		expect(getEnvApiKey("commandcode", { CMD_API_KEY: "cmd-key" })).toBe("cmd-key");
		expect(getEnvApiKey("commandcode", { COMMANDCODE_API_KEY: "alias-key" })).toBe("alias-key");
		expect(getEnvApiKey("commandcode", { CMD_API_KEY: "cmd-key", COMMANDCODE_API_KEY: "alias-key" })).toBe("cmd-key");
	});

	it("overlays a cached catalog without network access", async () => {
		const store = new InMemoryModelsStore();
		await store.write("commandcode", {
			models: [
				{
					id: "cached-model",
					name: "Cached Model",
					api: "anthropic-messages",
					provider: "commandcode",
					baseUrl: "https://api.commandcode.ai/provider",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: true },
					contextWindow: 32000,
					maxTokens: 32000,
				},
			],
			checkedAt: Date.now(),
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(commandCodeProvider());

		await models.refresh({ providers: ["commandcode"], allowNetwork: false });

		expect(models.getModel("commandcode", "cached-model")?.name).toBe("Cached Model");
	});
});
