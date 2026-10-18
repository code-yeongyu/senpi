import {
	type AnyModel,
	type Api,
	getModelType,
	isModelType,
	type Model,
	type ModelsStoreEntry,
	type ModelType,
	type Provider,
} from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { mergeRemoteCatalogModels, parseRemoteCatalog, type RemoteCatalogConflict } from "./remote-catalog-merge.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/**
 * Model types this client can consume. Sent as `?types=` so the catalog server
 * returns the full-type shard instead of the chat-only one served to clients
 * that predate model types. A server that ignores the parameter still returns
 * the chat-only shard, which this client handles unchanged.
 */
export const REMOTE_CATALOG_MODEL_TYPES: readonly ModelType[] = ["chat", "image", "classifier"];
const NON_CHAT_MODEL_TYPES: readonly ModelType[] = REMOTE_CATALOG_MODEL_TYPES.filter((type) => type !== "chat");

/**
 * Builtin providers that exist only in this fork. Upstream's pi.dev catalog does
 * not serve them and answers with a non-404 failure, which becomes a chronic
 * per-refresh "Could not refresh <id>" warning (transient failures never persist
 * lastModified, so the freshness throttle below never engages for them).
 */
export const FORK_ONLY_BUILTIN_PROVIDERS: ReadonlySet<string> = new Set(["alibaba-token-plan", "opengateway"]);

/**
 * Whether the remote catalog overlay can serve a provider. Fork-only providers
 * are skipped under the default upstream catalog base URL; a custom base URL (a
 * fork-owned catalog) may serve them, so the wrap is preserved there.
 */
export function remoteCatalogServesProvider(providerId: string, catalogBaseUrl?: string): boolean {
	return catalogBaseUrl !== undefined || !FORK_ONLY_BUILTIN_PROVIDERS.has(providerId);
}

function isSupportedModelType(model: { type?: unknown }): boolean {
	return (
		model.type === undefined ||
		(typeof model.type === "string" && REMOTE_CATALOG_MODEL_TYPES.includes(model.type as ModelType))
	);
}

function mergeModels<TModel extends AnyModel>(baseline: readonly TModel[], dynamic: readonly TModel[]): TModel[] {
	const merged = new Map<string, TModel>();
	for (const model of [...baseline, ...dynamic]) merged.set(`${getModelType(model)}\0${model.id}`, model);
	return [...merged.values()];
}

const remoteCatalogConflicts = new WeakMap<Provider, readonly RemoteCatalogConflict[]>();

/** Return capability conflicts rejected from a provider's remote overlay. */
export function getRemoteCatalogConflicts(provider: Provider): readonly RemoteCatalogConflict[] {
	return remoteCatalogConflicts.get(provider) ?? [];
}

function chatModels(models: readonly AnyModel[]): Model<Api>[] {
	return models.filter((model): model is Model<Api> => isModelType(model, "chat"));
}

function nonChatModels(models: readonly AnyModel[]): AnyModel[] {
	return models.filter((model) => !isModelType(model, "chat"));
}

/**
 * Parse a remote catalog body. Chat entries keep the fork's strict shape validation
 * (`parseRemoteCatalog`: one malformed chat row rejects the body); image and
 * classifier entries of a supported type pass through, unsupported types are dropped.
 */
function parseCatalog(providerId: string, value: unknown): AnyModel[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	const supported = entries
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		.filter(isSupportedModelType);
	const isNonChat = (entry: Record<string, unknown>): boolean =>
		NON_CHAT_MODEL_TYPES.includes(entry.type as ModelType);
	const chat = supported.filter((entry) => !isNonChat(entry));
	const other = supported
		.filter((entry) => isNonChat(entry) && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }) as AnyModel);
	return [...parseRemoteCatalog(providerId, chat), ...other];
}

function remoteModels(entry: ModelsStoreEntry | undefined, localGeneratedAt: number | undefined): readonly AnyModel[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly AnyModel[] = [];
	const currentChatModels = (): Model<Api>[] =>
		mergeRemoteCatalogModels(provider.id, provider.getModels(), chatModels(dynamicModels)).models;
	const conflictsFor = (models: readonly AnyModel[]): readonly RemoteCatalogConflict[] =>
		mergeRemoteCatalogModels(provider.id, provider.getModels(), chatModels(models)).conflicts;
	const wrappedProvider: Provider = {
		...provider,
		getModels: currentChatModels,
		getAllModels: () => [
			...currentChatModels(),
			...mergeModels(nonChatModels(provider.getAllModels?.() ?? []), nonChatModels(dynamicModels)),
		],
		refreshModels: async (context) => {
			const stored = context.stored;
			const restored = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
						remoteCatalogConflicts.set(wrappedProvider, conflictsFor(restored));
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored && stored.models.length > 0 ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			url.searchParams.set("types", REMOTE_CATALOG_MODEL_TYPES.join(","));
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
						lastModified: 0,
						etag: undefined,
					},
				});
				return;
			}
			if (!response.ok) {
				// Transient failure: the cached body and its validator stay valid, so keep the
				// etag and let the next refresh revalidate instead of downloading the catalog.
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry: ModelsStoreEntry = {
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
					remoteCatalogConflicts.set(wrappedProvider, conflictsFor(published));
				},
			});
		},
	};
	remoteCatalogConflicts.set(wrappedProvider, []);
	return wrappedProvider;
}
