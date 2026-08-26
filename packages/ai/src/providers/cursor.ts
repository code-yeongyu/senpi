import { cursorAgentApi, loadCursorAgentModule } from "../api/cursor-agent.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadCursorOAuth } from "../auth/oauth/load.ts";
import { normalizeCursorCatalog } from "../cursor/catalog-grouping.ts";
import { regroupStoredCursorModels } from "../cursor/store-migration.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

const CURSOR_BASE_URL = "https://api2.cursor.sh";

/**
 * Cursor's catalog is fully dynamic: `GetUsableModels` requires an
 * authenticated access token and reports the account's usable models, so the
 * provider ships no static baseline. The discovery call lives in the
 * Node-only `cursor-agent` API module, loaded through the bundler-opaque
 * lazy boundary so the provider factory stays browser-safe.
 */
async function fetchCursorModels(context: RefreshModelsContext): Promise<Model<"cursor-agent">[]> {
	const credential = context.credential;
	const accessToken = credential?.type === "oauth" ? credential.access : credential?.key;
	if (!accessToken) return [];
	const { fetchCursorUsableModels } = await loadCursorAgentModule();
	const discovered = await fetchCursorUsableModels({ apiKey: accessToken, signal: context.signal });
	if (discovered === null) {
		throw new Error("Could not load Cursor model catalog from GetUsableModels");
	}
	const normalized = normalizeCursorCatalog(
		discovered.map((model) => ({
			id: model.id,
			name: model.name,
			input: model.input,
			cursorMaxMode: model.cursorMaxMode,
		})),
	);
	const maxTokensByVariant = new Map(discovered.map((model) => [model.id, model.maxTokens]));
	return normalized.map((entry): Model<"cursor-agent"> => {
		const representative = entry.representativeVariantId ?? entry.legacyAliases[0] ?? entry.id;
		const maxTokens = maxTokensByVariant.get(representative) ?? maxTokensByVariant.get(entry.id) ?? 64000;
		return {
			id: entry.id,
			name: entry.name,
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: CURSOR_BASE_URL,
			reasoning: entry.reasoning,
			...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
			input: entry.input,
			// Subscription-billed: Cursor reports no per-token pricing here.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: entry.window,
			maxTokens,
			...(entry.representativeVariantId !== undefined && entry.representativeVariantId !== entry.id
				? { upstreamModelId: entry.representativeVariantId }
				: {}),
			compat: {
				...(entry.cursorMaxMode ? { cursorMaxMode: true } : {}),
				...(entry.capabilityId !== undefined && entry.representativeVariantId !== undefined
					? {
							cursorReasoning: {
								capabilityId: entry.capabilityId,
								...(entry.thinkingMode !== undefined ? { thinkingMode: entry.thinkingMode } : {}),
								representativeVariantId: entry.representativeVariantId,
							},
						}
					: {}),
			},
		};
	});
}

/**
 * Cursor subscription provider (OAuth only).
 *
 * Chat runs on Cursor's protobuf Connect-RPC agent protocol
 * (`agent.v1.AgentService/Run` on `api2.cursor.sh`), implemented by the
 * `cursor-agent` API. The model catalog is discovered per account through
 * `GetUsableModels` after login (`Models.refresh` runs automatically after a
 * successful `/login cursor`).
 */
export function cursorProvider(): Provider<"cursor-agent"> {
	return createProvider({
		id: "cursor",
		name: "Cursor",
		baseUrl: CURSOR_BASE_URL,
		restoreModels: (models) => regroupStoredCursorModels(models),
		auth: {
			oauth: lazyOAuth({
				name: "Cursor (Pro/Ultra/Teams)",
				isSubscription: true,
				loginLabel: "Sign in with Cursor",
				load: loadCursorOAuth,
			}),
		},
		models: [],
		fetchModels: fetchCursorModels,
		api: cursorAgentApi(),
	});
}
