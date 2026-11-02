import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRemoteCatalogConflicts, withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

async function refreshProvider(provider: Provider, store: InMemoryModelsStore): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: true,
		signal: neverAbortedSignal,
	});
}

function provider(models: readonly Model<"openai-completions">[]): Provider {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models,
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
	);
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog authority", () => {
	it("never drops static input modalities when remote metadata is narrower", async () => {
		const staticModel = {
			...model("k3"),
			input: ["text", "image", "video"] as Model<"openai-completions">["input"],
		};
		const remoteModel = { ...model("k3"), input: ["text", "image"] };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ k3: remoteModel }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const wrapped = provider([staticModel]);
		await refreshProvider(wrapped, new InMemoryModelsStore());

		expect(wrapped.getModels().find((entry) => entry.id === "k3")?.input).toEqual(["text", "image", "video"]);
	});

	it("preserves static limits while refreshing remote pricing", async () => {
		const staticModel = { ...model("gpt-5.6-sol"), contextWindow: 650_000, maxTokens: 128_000 };
		const remoteModel = {
			...model("gpt-5.6-sol"),
			contextWindow: 272_000,
			maxTokens: 128_000,
			cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ sol: remoteModel }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const wrapped = provider([staticModel]);
		await refreshProvider(wrapped, new InMemoryModelsStore());

		const merged = wrapped.getModels().find((entry) => entry.id === "gpt-5.6-sol");
		expect(merged?.contextWindow).toBe(650_000);
		expect(merged?.cost.input).toBe(9);
	});

	it("preserves omitted fast rows and reports capability conflicts", async () => {
		const staticModel = {
			...model("gpt-6-astra"),
			input: ["text", "image", "video"] as Model<"openai-completions">["input"],
			contextWindow: 600_000,
		};
		const staticFastModel = { ...staticModel, id: "gpt-6-astra-fast", serviceTier: "priority" as const };
		const remoteModel = {
			...staticModel,
			input: ["text"],
			contextWindow: 272_000,
			serviceTier: "auto" as const,
			cost: { input: 3, output: 3, cacheRead: 3, cacheWrite: 3 },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ astra: remoteModel }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const wrapped = provider([staticModel, staticFastModel]);
		await refreshProvider(wrapped, new InMemoryModelsStore());

		const models = wrapped.getModels();
		expect(models.map((entry) => entry.id)).toEqual(["gpt-6-astra", "gpt-6-astra-fast"]);
		expect(models[0]?.contextWindow).toBe(600_000);
		expect(models[0]?.input).toEqual(["text", "image", "video"]);
		expect(getRemoteCatalogConflicts(wrapped)).toEqual([
			{
				providerId: "test-provider",
				modelId: "gpt-6-astra",
				fields: ["contextWindow", "input", "serviceTier"],
			},
		]);
	});

	it("rejects a remote row missing required model fields", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ malformed: { id: "malformed", contextWindow: 272_000 } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		const wrapped = provider([model("static")]);
		await expect(refreshProvider(wrapped, new InMemoryModelsStore())).rejects.toThrow(
			'Invalid model catalog for provider "test-provider"',
		);
		expect(wrapped.getModels().map((entry) => entry.id)).toEqual(["static"]);
	});
});
