// Runtime refresh for the OpenGateway provider. A successful gateway listing is
// authoritative for availability; the shipped catalog (generated from the gateway
// plus models.dev) supplies metadata and is the offline fallback:
//
// - a servable model the shipped catalog lacks is added, built from its shipped
//   serving-tier base when there is one, priced from the gateway price table;
// - a shipped model the gateway retired, or no longer lists, is removed;
// - shipped rows keep their generated metadata (input caps, thinking maps,
//   prices). Correcting those is the scheduled catalog regeneration's job.
//
// Any fetch or parse failure keeps the last good list and surfaces as a refresh error.

import type { RefreshModelsContext } from "../models.ts";
import type { AnyModel, Model } from "../types.ts";
import { isModelType } from "../utils/model-operations.ts";
import { OAuthTokenEndpointError } from "../utils/oauth-refresh-error.ts";
import { applyOpenAiInputCap } from "../utils/openai-input-cap.ts";
import {
	isServableChatModel,
	OPENGATEWAY_BASE_URL,
	OPENGATEWAY_MODELS_URL,
	OPENGATEWAY_PRICES_URL,
	type OpenGatewayListedModel,
	type OpenGatewayPriceTable,
	openGatewayPrice,
	parseOpenGatewayListing,
	parseOpenGatewayPriceTable,
	servingTierBase,
	withGatewayPrice,
} from "./opengateway-catalog.ts";

type OpenGatewayModel = Model<"openai-completions">;

export const OPENGATEWAY_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Max output for an added model the gateway publishes no limit for and that has no shipped base. */
const UNPUBLISHED_MAX_OUTPUT_TOKENS = 32768;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function addedModel(
	item: OpenGatewayListedModel,
	shippedById: ReadonlyMap<string, OpenGatewayModel>,
	prices: OpenGatewayPriceTable,
): OpenGatewayModel | undefined {
	const price = openGatewayPrice(item, prices);
	// An unpriced model would bill as free in usage accounting; wait for the regeneration instead.
	if (price?.input === undefined || price.output === undefined) return undefined;
	const tier = servingTierBase(item.id);
	const base = tier ? shippedById.get(tier.baseId) : undefined;
	const contextWindow = item.contextWindow ?? base?.contextWindow;
	if (contextWindow === undefined) return undefined;
	const template: OpenGatewayModel = base
		? { ...base, name: `${base.name} ${tier?.label}` }
		: {
				id: item.id,
				name: item.id,
				api: "openai-completions",
				provider: "opengateway",
				baseUrl: OPENGATEWAY_BASE_URL,
				compat: { supportsDeveloperRole: false },
				reasoning: false,
				input: ["text"],
				cost: ZERO_COST,
				contextWindow,
				maxTokens: UNPUBLISHED_MAX_OUTPUT_TOKENS,
			};
	const model: OpenGatewayModel = {
		...template,
		id: item.id,
		input: item.inputModalities.includes("image") ? ["text", "image"] : ["text"],
		cost: withGatewayPrice(ZERO_COST, price),
		contextWindow,
		maxTokens: Math.min(item.maxOutputTokens ?? template.maxTokens, contextWindow),
	};
	applyOpenAiInputCap(model);
	return model;
}

/** Servable gateway models the shipped catalog lacks; only these need the price table. */
export function unshippedServableModels(
	shipped: readonly OpenGatewayModel[],
	listing: readonly OpenGatewayListedModel[],
): OpenGatewayListedModel[] {
	const shippedIds = new Set(shipped.map((model) => model.id));
	return listing.filter((item) => isServableChatModel(item) && !shippedIds.has(item.id));
}

export function overlayOpenGatewayCatalog(
	shipped: readonly OpenGatewayModel[],
	listing: readonly OpenGatewayListedModel[],
	prices: OpenGatewayPriceTable,
): OpenGatewayModel[] {
	const servable = new Set(listing.filter(isServableChatModel).map((item) => item.id));
	const shippedById = new Map(shipped.map((model) => [model.id, model]));
	const added = unshippedServableModels(shipped, listing).flatMap(
		(item) => addedModel(item, shippedById, prices) ?? [],
	);
	return [...shipped.filter((model) => servable.has(model.id)), ...added];
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, { headers: { accept: "application/json" }, signal });
	if (!response.ok)
		throw new OAuthTokenEndpointError(
			`OpenGateway catalog request failed: ${url} returned ${response.status}`,
			response.status,
		);
	return response.json();
}

async function fetchRefreshedCatalog(
	shipped: readonly OpenGatewayModel[],
	signal: AbortSignal,
): Promise<OpenGatewayModel[]> {
	const listing = parseOpenGatewayListing(await fetchJson(OPENGATEWAY_MODELS_URL, signal));
	const prices =
		unshippedServableModels(shipped, listing).length > 0
			? parseOpenGatewayPriceTable(await fetchJson(OPENGATEWAY_PRICES_URL, signal))
			: [];
	const refreshed = overlayOpenGatewayCatalog(shipped, listing, prices);
	if (refreshed.length === 0)
		throw new Error("OpenGateway listing has no servable chat models; keeping the last good catalog");
	return refreshed;
}

function isOpenGatewayChatModel(model: AnyModel): model is OpenGatewayModel {
	return model.provider === "opengateway" && isModelType(model, "chat") && model.api === "openai-completions";
}

/**
 * Catalog state for the provider: `getModels()` is synchronous, `refresh()` restores the
 * persisted list and revalidates it against the gateway at most hourly. A persisted list
 * older than the shipped catalog is ignored, so an upgrade never resurrects metadata the
 * new release corrected.
 */
export function createOpenGatewayCatalog(shipped: readonly OpenGatewayModel[], shippedGeneratedAt: number | undefined) {
	let current: readonly OpenGatewayModel[] = shipped;
	return {
		getModels: (): readonly OpenGatewayModel[] => current,
		refresh: async (context: RefreshModelsContext): Promise<void> => {
			const stored = context.stored;
			const storedCheckedAt = stored?.checkedAt;
			const usable =
				stored !== undefined &&
				storedCheckedAt !== undefined &&
				(shippedGeneratedAt === undefined || storedCheckedAt > shippedGeneratedAt);
			if (usable && stored) {
				const restored = stored.models.filter(isOpenGatewayChatModel);
				if (
					!(await context.publish({
						update: () => {
							current = restored;
						},
					}))
				)
					return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			const age = Date.now() - (storedCheckedAt ?? 0);
			if (!context.force && usable && age >= 0 && age < OPENGATEWAY_REFRESH_INTERVAL_MS) return;

			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
			const refreshed = await fetchRefreshedCatalog(shipped, signal);
			if (context.signal.aborted) return;
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					current = refreshed;
				},
			});
		},
	};
}
