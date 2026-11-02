export const GATEWAY_URL = "https://apis.opengateway.ai/v1/models";
export const PRICES_URL = "https://opengateway.ai/api/model-prices";

export interface ListedModel {
	id: string;
	status?: string;
	endpoints?: string[];
	input?: string[];
	routes?: string[];
	context_window?: number;
	max_output_tokens?: number;
}

export function gatewayResponse(models: ListedModel[]) {
	return {
		object: "list",
		data: models.map((model) => ({
			id: model.id,
			object: "model",
			status: model.status ?? "active",
			modalities: { input: model.input ?? ["text"], output: ["text"] },
			endpoints: model.endpoints ?? ["chat_completions"],
			providers: (model.routes ?? ["primary"]).map((id) => ({ id, region: "global" })),
			...(model.context_window ? { context_window: model.context_window } : {}),
			...(model.max_output_tokens ? { max_output_tokens: model.max_output_tokens } : {}),
		})),
	};
}

export interface RoutePrice {
	route?: string;
	input: number;
	output: number;
	cacheRead?: number | null;
	tiers?: Record<string, { input: number; output: number; cacheRead: number | null; cacheCreation: number | null }>;
}

/** Prices are given per million tokens and published per token, as the gateway does. */
export function priceTable(prices: Record<string, RoutePrice>) {
	return Object.fromEntries(
		Object.entries(prices).map(([id, price]) => {
			const [owner, name] = id.split("/");
			const route = price.route ?? "primary";
			const effectivePrice = {
				inputCostPerToken: price.input / 1e6,
				outputCostPerToken: price.output / 1e6,
				cacheReadInputTokenCost:
					price.cacheRead === undefined || price.cacheRead === null ? null : price.cacheRead / 1e6,
				cacheCreationInputTokenCost: null,
				axisPrices: Object.fromEntries(
					Object.entries(price.tiers ?? {}).map(([threshold, tier]) => [
						`AxisKey(threshold=${threshold}, tier=null)`,
						{
							input: tier.input / 1e6,
							output: tier.output / 1e6,
							cacheRead: tier.cacheRead === null ? null : tier.cacheRead / 1e6,
							cacheCreation: tier.cacheCreation === null ? null : tier.cacheCreation / 1e6,
							isEmpty: false,
						},
					]),
				),
			};
			return [
				`${route}/${name}`,
				{ provider: route, modelOwner: owner, modelName: name, pricing: { current: { effectivePrice } } },
			];
		}),
	);
}
