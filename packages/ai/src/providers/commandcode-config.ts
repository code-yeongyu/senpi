import type { Model } from "../types.ts";

/**
 * Command Code's provider API. Claude models are served over the Anthropic wire
 * (`/v1/messages`); every other model is served over OpenAI chat completions
 * (`/v1/chat/completions`). Both slices live under the same host.
 * https://commandcode.ai/docs/provider (checked 2026-10-24)
 */
export const COMMANDCODE_PROVIDER_BASE_URL = "https://api.commandcode.ai/provider";

const COMMANDCODE_MODELS_URL = `${COMMANDCODE_PROVIDER_BASE_URL}/v1/models`;

/**
 * Plan-scoped API keys list the catalog under a plan namespace
 * (`commandcode-goat-plan/claude-sonnet-5-5`), while requests take the bare id
 * and the public catalog already publishes bare and vendor ids
 * (`claude-sonnet-5-5`, `deepseek/deepseek-v4-pro`). Only these namespaces are
 * stripped: `deepseek/`, `xiaomi/` and the other vendor prefixes are part of
 * the model id.
 */
const COMMANDCODE_PLAN_NAMESPACES = ["commandcode-goat-plan/", "commandcode-goat/"];

/**
 * `/models` publishes a context length but no output cap. Discovered-only rows
 * take this conservative cap until models.dev describes the id; the next
 * generation run replaces it with the published value.
 */
const COMMANDCODE_DISCOVERED_MAX_TOKENS = 32000;

export type CommandCodeApi = "anthropic-messages" | "openai-completions";

export type CommandCodeCatalogEntry = {
	id: string;
	name?: string;
	context_length?: number;
	supported_endpoints?: string[];
};

function isCommandCodeCatalogEntry(value: unknown): value is CommandCodeCatalogEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const entry = value as Partial<CommandCodeCatalogEntry>;
	return (
		typeof entry.id === "string" &&
		(entry.name === undefined || typeof entry.name === "string") &&
		(entry.context_length === undefined || typeof entry.context_length === "number") &&
		(entry.supported_endpoints === undefined ||
			(Array.isArray(entry.supported_endpoints) &&
				entry.supported_endpoints.every((endpoint) => typeof endpoint === "string")))
	);
}

function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

function normalizeCommandCodeModelId(id: string): string {
	const namespace = COMMANDCODE_PLAN_NAMESPACES.find((prefix) => id.startsWith(prefix));
	const bareId = namespace ? id.slice(namespace.length) : id;
	return bareId.length > 0 ? bareId : id;
}

/** The wire a model is served on; models that list both endpoints take chat completions. */
function commandCodeApiFor(entry: CommandCodeCatalogEntry): CommandCodeApi | undefined {
	const endpoints = entry.supported_endpoints ?? [];
	if (endpoints.includes("/chat/completions")) return "openai-completions";
	if (endpoints.includes("/messages")) return "anthropic-messages";
	return undefined;
}

/**
 * Turn the `/models` catalog into provider rows, taking cost, reasoning and
 * input modalities from the generated baseline where it knows the id. Rows the
 * baseline does not know are marked `cost.unknown` rather than priced at zero.
 */
export function getCommandCodeModelsFromCatalog(
	providerId: string,
	catalog: readonly CommandCodeCatalogEntry[],
	baseline: (id: string) => Model<CommandCodeApi> | undefined,
): Model<CommandCodeApi>[] {
	const models: Model<CommandCodeApi>[] = [];
	const seen = new Set<string>();
	for (const entry of catalog) {
		const id = normalizeCommandCodeModelId(entry.id);
		if (seen.has(id)) continue;
		const api = commandCodeApiFor(entry);
		if (!api) continue;
		seen.add(id);

		const known = baseline(id);
		const contextWindow = entry.context_length ?? known?.contextWindow ?? 4096;
		models.push({
			...(known ?? {
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: true },
			}),
			id,
			name: entry.name || known?.name || id,
			api,
			provider: providerId,
			// The Anthropic SDK appends /v1/messages to its base URL.
			baseUrl: api === "anthropic-messages" ? COMMANDCODE_PROVIDER_BASE_URL : `${COMMANDCODE_PROVIDER_BASE_URL}/v1`,
			contextWindow,
			maxTokens: known?.maxTokens ?? Math.min(COMMANDCODE_DISCOVERED_MAX_TOKENS, contextWindow),
		} as Model<CommandCodeApi>);
	}
	return models;
}

/** Fetch the public `/models` catalog. Plan namespaces are normalized by the caller-facing builder. */
export async function loadCommandCodeCatalog(signal?: AbortSignal): Promise<CommandCodeCatalogEntry[]> {
	const response = await fetch(COMMANDCODE_MODELS_URL, { headers: { accept: "application/json" }, signal });
	if (!response.ok) {
		throw new Error(
			`Could not load the Command Code model catalog from ${COMMANDCODE_MODELS_URL}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	const payload = (await response.json()) as { data?: unknown };
	if (!Array.isArray(payload.data)) {
		throw new Error(`Invalid Command Code model catalog from ${COMMANDCODE_MODELS_URL}`);
	}
	return payload.data.filter(isCommandCodeCatalogEntry);
}
