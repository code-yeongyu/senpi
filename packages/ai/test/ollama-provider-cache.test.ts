import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelsPublication, RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { ollamaProvider } from "../src/providers/ollama.ts";
import type { Model } from "../src/types.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

async function refreshContext(
	store: InMemoryModelsStore,
	signal: AbortSignal = new AbortController().signal,
): Promise<RefreshModelsContext> {
	return {
		stored: await store.read("ollama"),
		publish: async (publication: ModelsPublication) => {
			if (publication.persist === null) await store.delete("ollama");
			else if (publication.persist) await store.write("ollama", publication.persist);
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal,
	};
}

function cachedOllamaModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "ollama",
		baseUrl: "https://ollama.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

describe("Ollama Cloud catalog retention", () => {
	it("preserves the cached catalog when successful discovery returns no tool-capable models", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({ models: [{ name: "embedding-only" }] });
			}
			if (url === "https://ollama.example.test/api/show") {
				return Response.json({
					model_info: { "general.architecture": "embed", "embed.context_length": 8192 },
					capabilities: ["embedding"],
				});
			}
			return new Response("not found", { status: 404 });
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();
		const cachedEntry = { models: [cachedOllamaModel("coding-model")], checkedAt: 1 };
		await store.write("ollama", cachedEntry);

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			...(await refreshContext(store)),
		});

		expect(provider.getModels().map((model) => model.id)).toEqual(["coding-model"]);
		expect(await store.read("ollama")).toEqual(cachedEntry);
	});

	it("preserves a cached tool model when its inspection fails beside a successful non-tool model", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({ models: [{ name: "coding-model" }, { name: "embedding-only" }] });
			}
			if (url === "https://ollama.example.test/api/show") {
				const body = JSON.parse(String(init?.body)) as { model: string };
				if (body.model === "coding-model") return new Response("temporary failure", { status: 503 });
				return Response.json({
					model_info: { "general.architecture": "embed", "embed.context_length": 8192 },
					capabilities: ["embedding"],
				});
			}
			return new Response("not found", { status: 404 });
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();
		await store.write("ollama", { models: [cachedOllamaModel("coding-model")], checkedAt: 1 });

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "test-key" },
			...(await refreshContext(store)),
		});

		expect(provider.getModels().map((model) => model.id)).toEqual(["coding-model"]);
		expect((await store.read("ollama"))?.models.map((model) => model.id)).toEqual(["coding-model"]);
	});

	it("does not expose an upstream error response body", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({ models: [{ name: "broken" }] });
			}
			return new Response("reflected-sensitive-value", { status: 500, statusText: "reflected-status" });
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();

		const failure = await provider
			.refreshModels?.({
				credential: { type: "api_key", key: "test-key" },
				...(await refreshContext(store)),
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("500");
		expect((failure as Error).message).not.toContain("reflected-sensitive-value");
		expect((failure as Error).message).not.toContain("reflected-status");
	});

	it("keeps the cached catalog when refresh is aborted during inspection", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url === "https://ollama.example.test/api/tags") {
				return Response.json({ models: [{ name: "coding-model" }] });
			}
			controller.abort(new Error("cancelled"));
			throw controller.signal.reason;
		});
		const provider = ollamaProvider({ baseUrl: "https://ollama.example.test" });
		const store = new InMemoryModelsStore();
		await store.write("ollama", { models: [cachedOllamaModel("coding-model")], checkedAt: 1 });

		await expect(
			provider.refreshModels?.({
				credential: { type: "api_key", key: "test-key" },
				...(await refreshContext(store, controller.signal)),
			}),
		).rejects.toThrow("cancelled");

		expect(provider.getModels().map((model) => model.id)).toEqual(["coding-model"]);
		expect((await store.read("ollama"))?.models.map((model) => model.id)).toEqual(["coding-model"]);
	});
});
