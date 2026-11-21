import type { ModelsPublication, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyCredential } from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { composedProvider } from "../support/anthropic-subscription-provider.ts";

const CATALOG_IDS = getModels("anthropic").map((model) => model.id);

function stubListing(...pages: Array<{ ids: string[] } | { status: number }>): Request[] {
	const requests: Request[] = [];
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push(new Request(input, init));
		const page = pages.shift();
		if (!page) throw new Error("unexpected model list request");
		if ("status" in page) return new Response("{}", { status: page.status });
		return Response.json({ data: page.ids.map((id) => ({ type: "model", id })), has_more: false });
	});
	return requests;
}

function refreshContext(
	persisted: ModelsStoreEntry[],
	overrides: Partial<RefreshModelsContext> = {},
): RefreshModelsContext {
	return {
		credential: emptyCredential(),
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication: ModelsPublication) => {
			if (publication.persist) persisted.push(publication.persist);
			publication.update?.();
			return true;
		},
		...overrides,
	};
}

describe("anthropic-subscription account model listing", () => {
	beforeEach(() => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-token");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("lists the Mythos release a verified account returns and restores it from the stored listing", async () => {
		const requests = stubListing({ ids: ["claude-mythos-5-2", "claude-fable-5-2", "claude-opus-5"] });
		const persisted: ModelsStoreEntry[] = [];
		const provider = composedProvider(async () => false);

		await provider.refreshModels?.(refreshContext(persisted));

		expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer env-token");
		expect(requests[0]?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		const fable = provider.getModels().find((model) => model.id === "claude-fable-5-2");
		expect(provider.getModels().find((model) => model.id === "claude-mythos-5-2")).toMatchObject({
			name: "Claude Mythos 5.2",
			contextWindow: fable?.contextWindow,
			maxTokens: fable?.maxTokens,
			thinkingLevelMap: fable?.thinkingLevelMap,
		});
		expect(persisted.at(-1)?.models.map((model) => [model.provider, model.id])).toEqual([
			["anthropic-subscription", "claude-mythos-5-2"],
		]);

		const restarted = composedProvider(async () => false);
		await restarted.refreshModels?.(refreshContext([], { stored: persisted.at(-1), allowNetwork: false }));
		expect(restarted.getModels().map((model) => model.id)).toEqual([...CATALOG_IDS, "claude-mythos-5-2"]);
	});

	it("adds nothing for an account whose listing has no gated release", async () => {
		stubListing({ ids: ["claude-fable-5-2", "claude-opus-5", "claude-mythos-6"] });
		const provider = composedProvider(async () => false);

		await provider.refreshModels?.(refreshContext([]));

		expect(provider.getModels().map((model) => model.id)).toEqual(CATALOG_IDS);
	});

	it("keeps the last listing when the model list request fails", async () => {
		stubListing({ ids: ["claude-mythos-5-2"] }, { status: 500 });
		const provider = composedProvider(async () => false);
		await provider.refreshModels?.(refreshContext([]));

		await expect(provider.refreshModels?.(refreshContext([]))).rejects.toThrow(
			"Could not list Anthropic models: 500",
		);

		expect(provider.getModels().map((model) => model.id)).toEqual([...CATALOG_IDS, "claude-mythos-5-2"]);
	});
});
