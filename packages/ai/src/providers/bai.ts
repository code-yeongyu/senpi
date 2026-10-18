import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { BAI_MODELS } from "./bai.models.ts";
import { baiResponsesStreams } from "./bai-stream.ts";

export const BAI_BASE_URL = "https://api.b.ai/v1";

export type BaiApi = "openai-responses" | "openai-completions" | "anthropic-messages";

export interface BaiProviderOptions {
	baseUrl?: string;
	models?: readonly Model<BaiApi>[];
	fetch?: typeof fetch;
}

type BaiModelsResponse = {
	success?: boolean;
	message?: string;
	data?: Array<{ id?: string }>;
};

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/u, "");
}

/**
 * B.AI documents dot-version model IDs on most model pages (`gpt-5.6-sol`,
 * `gemini-3.5-flash-lite`) but hyphenated ones for Claude (`claude-fable-5-1`),
 * and its Claude Code guide states that "both hyphenated aliases and
 * dot-version aliases are accepted". Which spelling `GET /v1/models` returns is
 * therefore not fixed, so the catalog is indexed under both to keep discovery
 * from silently dropping an entitled model.
 */
function modelIdAliases(id: string): string[] {
	const dashed = id.replaceAll(".", "-");
	return dashed === id ? [id] : [id, dashed];
}

function indexCatalog(catalog: readonly Model<BaiApi>[]): Map<string, Model<BaiApi>> {
	const index = new Map<string, Model<BaiApi>>();
	for (const model of catalog) {
		for (const alias of modelIdAliases(model.id)) {
			if (!index.has(alias)) index.set(alias, model);
		}
	}
	return index;
}

function remapBaiModels(
	models: readonly Model<Api>[],
	catalogById: ReadonlyMap<string, Model<BaiApi>>,
): Model<BaiApi>[] {
	return models.flatMap((model) => {
		const current = catalogById.get(model.id);
		return current ? [current] : [];
	});
}

async function fetchBaiModels(
	baseUrl: string,
	catalogById: ReadonlyMap<string, Model<BaiApi>>,
	fetchImpl: typeof fetch,
	context: RefreshModelsContext,
): Promise<Model<BaiApi>[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
	if (!apiKey) return [];

	const response = await fetchImpl(`${baseUrl}/models`, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		signal: context.signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load B.AI model catalog: ${response.status}`);
	}

	const payload = (await response.json()) as BaiModelsResponse;
	if (payload.success === false) {
		throw new Error(`Could not load B.AI model catalog: ${payload.message?.trim() || "request rejected"}`);
	}
	if (!Array.isArray(payload.data)) {
		throw new Error("Invalid B.AI model catalog response");
	}

	const discovered = payload.data.flatMap((entry) => {
		const id = entry.id?.trim();
		const model = id ? catalogById.get(id) : undefined;
		return model ? [model] : [];
	});
	return [...new Map(discovered.map((model) => [model.id, model])).values()];
}

export function baiProvider(options: BaiProviderOptions = {}): Provider<BaiApi> {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? BAI_BASE_URL);
	const anthropicBaseUrl = baseUrl.replace(/\/v1$/u, "");
	const catalog = [...(options.models ?? Object.values(BAI_MODELS))].map((model) => ({
		...model,
		baseUrl: model.api === "anthropic-messages" ? anthropicBaseUrl : baseUrl,
	}));
	const catalogById = indexCatalog(catalog);
	const fetchImpl = options.fetch ?? fetch;

	return createProvider<BaiApi>({
		id: "bai",
		name: "B.AI",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("B.AI API key", ["BAI_API_KEY"]) },
		models: [],
		restoreModels: (models) => remapBaiModels(models, catalogById),
		fetchModels: (context) => fetchBaiModels(baseUrl, catalogById, fetchImpl, context),
		api: {
			// Only the Responses tool builder forwards a union-root schema unrepaired;
			// see the contract note in ./bai-stream.ts.
			"openai-responses": baiResponsesStreams(openAIResponsesApi()),
			"openai-completions": openAICompletionsApi(),
			"anthropic-messages": anthropicMessagesApi(),
		},
	});
}
