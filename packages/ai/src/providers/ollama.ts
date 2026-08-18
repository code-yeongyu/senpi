import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

export const DEFAULT_OLLAMA_CLOUD_URL = "https://ollama.com";
export const DEFAULT_OLLAMA_CONTEXT_WINDOW = 128000;
export const DEFAULT_OLLAMA_MAX_TOKENS = 16384;
const OLLAMA_SHOW_CONCURRENCY = 6;

export interface OllamaProviderOptions {
	baseUrl?: string;
}

type OllamaTagsModel = {
	name: string;
};

type OllamaShowResponse = {
	capabilities: string[];
	modelInfo: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOllamaHost(value: string): string {
	const host = new URL(value);
	host.pathname = host.pathname.replace(/\/v1\/?$/u, "");
	return host.toString().replace(/\/$/u, "");
}

async function fetchOllamaJson(
	url: URL,
	apiKey: string,
	signal: AbortSignal | undefined,
	init?: RequestInit,
): Promise<unknown> {
	const response = await fetch(url, {
		...init,
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
			...init?.headers,
		},
		signal,
	});
	if (!response.ok) {
		throw new Error(`Could not load Ollama catalog from ${url}: ${response.status}`);
	}
	return response.json();
}

function parseTagsResponse(value: unknown): OllamaTagsModel[] {
	if (!isRecord(value) || !Array.isArray(value.models)) {
		throw new Error("Invalid Ollama tags response");
	}
	const models: OllamaTagsModel[] = [];
	for (const entry of value.models) {
		if (!isRecord(entry)) continue;
		const name =
			typeof entry.name === "string" ? entry.name : typeof entry.model === "string" ? entry.model : undefined;
		if (name) models.push({ name });
	}
	return models;
}

function parseShowResponse(value: unknown): OllamaShowResponse {
	if (!isRecord(value) || !Array.isArray(value.capabilities)) {
		throw new Error("Invalid Ollama show response");
	}
	return {
		capabilities: value.capabilities.filter((entry): entry is string => typeof entry === "string"),
		modelInfo: isRecord(value.model_info) ? value.model_info : {},
	};
}

function getContextWindow(modelInfo: Record<string, unknown>): number {
	const architecture = modelInfo["general.architecture"];
	const preferred = typeof architecture === "string" ? modelInfo[`${architecture}.context_length`] : undefined;
	const candidate = preferred ?? Object.entries(modelInfo).find(([key]) => key.endsWith(".context_length"))?.[1];
	const parsed = typeof candidate === "number" ? candidate : Number(candidate);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OLLAMA_CONTEXT_WINDOW;
}

function toOllamaModel(
	host: string,
	entry: OllamaTagsModel,
	show: OllamaShowResponse,
): Model<"openai-completions"> | undefined {
	if (!show.capabilities.includes("tools")) return undefined;
	return {
		id: entry.name,
		name: entry.name,
		api: "openai-completions",
		provider: "ollama",
		baseUrl: `${host}/v1`,
		reasoning: show.capabilities.includes("thinking"),
		input: show.capabilities.includes("vision") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: getContextWindow(show.modelInfo),
		maxTokens: DEFAULT_OLLAMA_MAX_TOKENS,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		},
	};
}

async function fetchOllamaModels(host: string, context: RefreshModelsContext): Promise<Model<"openai-completions">[]> {
	const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
	if (!apiKey) return [];
	const tags = parseTagsResponse(await fetchOllamaJson(new URL("/api/tags", host), apiKey, context.signal));
	type Inspection =
		| { status: "fulfilled"; entry: OllamaTagsModel; model: Model<"openai-completions"> | undefined }
		| { status: "rejected"; entry: OllamaTagsModel; reason: unknown };
	const inspections: Inspection[] = new Array(tags.length);
	let nextIndex = 0;
	const inspectNext = async (): Promise<void> => {
		while (nextIndex < tags.length) {
			const index = nextIndex++;
			const entry = tags[index]!;
			try {
				const show = parseShowResponse(
					await fetchOllamaJson(new URL("/api/show", host), apiKey, context.signal, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ model: entry.name }),
					}),
				);
				inspections[index] = { status: "fulfilled", entry, model: toOllamaModel(host, entry, show) };
			} catch (reason) {
				inspections[index] = { status: "rejected", entry, reason };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(OLLAMA_SHOW_CONCURRENCY, tags.length) }, () => inspectNext()));
	const rejected = inspections.filter((inspection) => inspection.status === "rejected");
	if (context.signal?.aborted) {
		throw rejected[0]?.reason ?? context.signal.reason ?? new Error("Ollama catalog refresh aborted");
	}
	if (tags.length > 0 && rejected.length === tags.length) throw rejected[0]!.reason;
	const previousById = new Map(
		(context.stored?.models ?? [])
			.filter(
				(model): model is Model<"openai-completions"> =>
					model.provider === "ollama" && model.api === "openai-completions",
			)
			.map((model) => [model.id, model]),
	);
	const models = inspections.flatMap((inspection) => {
		if (inspection.status === "fulfilled") return inspection.model ? [inspection.model] : [];
		const previous = previousById.get(inspection.entry.name);
		return previous ? [previous] : [];
	});
	if (rejected.length > 0 && models.length === 0) throw rejected[0]!.reason;
	return models;
}

export function ollamaProvider(options: OllamaProviderOptions = {}): Provider<"openai-completions"> {
	const host = normalizeOllamaHost(options.baseUrl ?? DEFAULT_OLLAMA_CLOUD_URL);
	return createProvider({
		id: "ollama",
		name: "Ollama Cloud",
		baseUrl: `${host}/v1`,
		auth: { apiKey: envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]) },
		models: [],
		fetchModels: (context) => fetchOllamaModels(host, context),
		api: openAICompletionsApi(),
	});
}
