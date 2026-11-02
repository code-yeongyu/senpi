import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function codexModel(id: string, provider: string, contextWindow: number): Model<"openai-codex-responses"> {
	return {
		id,
		name: id,
		api: "openai-codex-responses",
		provider,
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow,
		maxTokens: 128000,
	};
}

function renamedProvider(id: string): Provider {
	return withRemoteCatalog(
		createProvider({
			id,
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [codexModel("builtin-shared", id, 500000)],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://pi.dev",
	);
}

async function refresh(provider: Provider, store: InMemoryModelsStore): Promise<void> {
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

function mockCatalogServer(served: Readonly<Record<string, readonly Model<"openai-codex-responses">[]>>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const providerId = new URL(String(input)).pathname.split("/").at(-1) ?? "";
		const models = served[decodeURIComponent(providerId)];
		if (models === undefined) return new Response("Not Found", { status: 404 });
		return new Response(JSON.stringify(models), { status: 200, headers: { "content-type": "application/json" } });
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog for renamed providers (senpi#4580)", () => {
	it("asks for openai-codex and files its models under chatgpt-subscription, builtin fields winning", async () => {
		const fetchSpy = mockCatalogServer({
			"openai-codex": [
				codexModel("upstream-only", "openai-codex", 500000),
				codexModel("builtin-shared", "openai-codex", 272000),
			],
		});
		const provider = renamedProvider("chatgpt-subscription");
		const store = new InMemoryModelsStore();

		await refresh(provider, store);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe("/api/models/providers/openai-codex");
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["builtin-shared", "upstream-only"]);
		expect(models.every((model) => model.provider === "chatgpt-subscription")).toBe(true);
		expect(models.find((model) => model.id === "builtin-shared")?.contextWindow).toBe(500000);
		expect((await store.read("chatgpt-subscription"))?.models.map((model) => model.id)).toEqual([
			"upstream-only",
			"builtin-shared",
		]);
	});

	it("keeps the baseline quietly when the upstream id is not served, and does not re-ask every refresh", async () => {
		const fetchSpy = mockCatalogServer({});
		const provider = renamedProvider("anthropic-subscription");
		const store = new InMemoryModelsStore();

		await expect(refresh(provider, store)).resolves.toBeUndefined();
		await expect(refresh(provider, store)).resolves.toBeUndefined();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).pathname).toBe("/api/models/providers/claude-sdk-oauth");
		expect(provider.getModels().map((model) => model.id)).toEqual(["builtin-shared"]);
	});
});
