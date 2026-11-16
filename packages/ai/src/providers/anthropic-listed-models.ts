/**
 * Account-scoped Anthropic model listing (`GET /v1/models`). Anthropic gates some releases to approved
 * organizations: Claude Mythos 5.x is the model behind Claude Fable 5.x, offered only to organizations approved
 * through Anthropic's verification programs, so the generated catalog (from models.dev) has no row for it. An
 * account whose own listing returns such an id gets a row derived from the catalogued sibling release.
 */
import type { Model } from "../types.ts";

type AnthropicModel = Model<"anthropic-messages">;

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const PAGE_LIMIT = 1000;

/** A gated release and the catalogued release it shares its model with: `claude-mythos-5-2` -> `claude-fable-5-2`. */
const SIBLING_RELEASES = [
	{ prefix: "claude-mythos-5", siblingPrefix: "claude-fable-5", name: "Mythos", siblingName: "Fable" },
] as const;

function siblingReleaseModel(catalogById: ReadonlyMap<string, AnthropicModel>, id: string): AnthropicModel | undefined {
	for (const release of SIBLING_RELEASES) {
		if (id !== release.prefix && !id.startsWith(`${release.prefix}-`)) continue;
		const sibling = catalogById.get(release.siblingPrefix + id.slice(release.prefix.length));
		if (!sibling) return undefined;
		// Anthropic accepts a server-side fallback target per requested model (it rejects Mythos as Fable's), so
		// the sibling's verified fallback pairs are not carried over to a model they were never verified for.
		const { allowedFallbackModels: _siblingFallbacks, ...compat } = sibling.compat ?? {};
		return {
			...sibling,
			id,
			name: sibling.name.replace(release.siblingName, release.name),
			// No published list price: usage reports an unknown cost instead of the sibling's.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unknown: true },
			compat,
		};
	}
	return undefined;
}

/**
 * The rows for the ids an account's listing returned, in listing order: a catalogued id as shipped, an
 * uncatalogued id of a gated release derived from its catalogued sibling, anything else dropped.
 */
export function listedAnthropicModels(catalog: readonly AnthropicModel[], ids: Iterable<string>): AnthropicModel[] {
	const catalogById = new Map(catalog.map((model) => [model.id, model]));
	const listed = new Map<string, AnthropicModel>();
	for (const id of ids) {
		const model = catalogById.get(id) ?? siblingReleaseModel(catalogById, id);
		if (model) listed.set(id, model);
	}
	return [...listed.values()];
}

function parsePage(value: unknown): { ids: string[]; nextAfter: string | undefined } {
	const page = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	if (!page || !Array.isArray(page.data)) throw new Error("Invalid Anthropic model list response");
	const ids = page.data.flatMap((entry: unknown) => {
		const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
		return typeof id === "string" && id !== "" ? [id] : [];
	});
	const nextAfter = page.has_more === true && typeof page.last_id === "string" ? page.last_id : undefined;
	return { ids, nextAfter };
}

/**
 * Every model id `GET /v1/models` lists for the credential in `headers` (`x-api-key`, or a subscription bearer
 * token with its beta). A credential the endpoint refuses (401/403, such as a gateway key that is only valid
 * behind a proxy) lists nothing; any other failure throws so the caller keeps its last catalog.
 */
export async function fetchAnthropicModelIds(
	headers: Readonly<Record<string, string>>,
	signal: AbortSignal,
): Promise<string[]> {
	const ids: string[] = [];
	let after: string | undefined;
	do {
		const url = new URL(ANTHROPIC_MODELS_URL);
		url.searchParams.set("limit", String(PAGE_LIMIT));
		if (after !== undefined) url.searchParams.set("after_id", after);
		const response = await fetch(url, {
			headers: { accept: "application/json", "anthropic-version": ANTHROPIC_VERSION, ...headers },
			signal,
		});
		if (response.status === 401 || response.status === 403) return [];
		if (!response.ok) throw new Error(`Could not list Anthropic models: ${response.status}`);
		const page = parsePage(await response.json());
		ids.push(...page.ids);
		after = page.nextAfter;
	} while (after !== undefined);
	return ids;
}
