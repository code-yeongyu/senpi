import {
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRemoteCatalog } from "../../../src/core/remote-catalog-provider.ts";

const PROVIDER_ID = "example-provider";
const BUNDLED_GENERATED_AT = Date.parse("2026-10-25T04:30:00.000Z");
const OLDER_THAN_BUNDLE = BUNDLED_GENERATED_AT - 24 * 60 * 60 * 1000;
const neverAbortedSignal = new AbortController().signal;

function model(id: string, name = id, inputCost = 0): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function bundledProvider(): Provider {
	return withRemoteCatalog(
		createProvider({
			id: PROVIDER_ID,
			auth: { apiKey: { name: "Example", resolve: async () => ({ auth: {} }) } },
			models: [model("model-a", "Model A (bundled)", 1)],
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
		BUNDLED_GENERATED_AT,
	);
}

async function refresh(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force">> = {},
): Promise<void> {
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
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: neverAbortedSignal,
	});
}

function staleRemoteCatalog(): Record<string, Model<"openai-completions">> {
	return {
		"model-a": model("model-a", "Model A (older remote)", 9),
		"model-new": model("model-new", "Model New"),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("issue #4314: remote catalog ids absent from a newer bundled catalog", () => {
	it("restores a cached older overlay's new model ids and keeps bundled metadata for known ids", async () => {
		const store = new InMemoryModelsStore();
		await store.write(PROVIDER_ID, {
			models: Object.values(staleRemoteCatalog()),
			checkedAt: Date.now(),
			lastModified: OLDER_THAN_BUNDLE,
		});
		const provider = bundledProvider();

		await refresh(provider, store, { allowNetwork: false });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["model-a", "model-new"]);
		expect(provider.getModels().find((entry) => entry.id === "model-a")).toMatchObject({
			name: "Model A (bundled)",
			cost: { input: 1 },
		});
	});

	it("publishes the new model ids of a fetched catalog older than the bundled catalog", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(staleRemoteCatalog()), {
				headers: { "content-type": "application/json", "last-modified": new Date(OLDER_THAN_BUNDLE).toUTCString() },
			}),
		);
		const store = new InMemoryModelsStore();
		const provider = bundledProvider();

		await refresh(provider, store);

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["model-a", "model-new"]);
		expect(provider.getModels().find((entry) => entry.id === "model-a")?.name).toBe("Model A (bundled)");
		expect((await store.read(PROVIDER_ID))?.models.map((entry) => entry.id)).toEqual(["model-a", "model-new"]);
	});

	it("keeps new model ids from a cached overlay that has no Last-Modified time", async () => {
		const store = new InMemoryModelsStore();
		await store.write(PROVIDER_ID, { models: Object.values(staleRemoteCatalog()), checkedAt: Date.now() });
		const provider = bundledProvider();

		await refresh(provider, store, { allowNetwork: false });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["model-a", "model-new"]);
	});

	it("does not bring back a cached overlay after the catalog route becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify(staleRemoteCatalog()), {
				headers: {
					"content-type": "application/json",
					"last-modified": new Date(BUNDLED_GENERATED_AT + 60_000).toUTCString(),
				},
			}),
			new Response("not found", { status: 404 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const store = new InMemoryModelsStore();
		await refresh(bundledProvider(), store);
		await refresh(bundledProvider(), store, { force: true });

		const restarted = bundledProvider();
		await refresh(restarted, store, { allowNetwork: false });

		expect(restarted.getModels().map((entry) => entry.id)).toEqual(["model-a"]);
	});
});
