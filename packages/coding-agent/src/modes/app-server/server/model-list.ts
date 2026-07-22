import type { Api, Model as PiModel } from "@earendil-works/pi-ai";
import { defaultModelPerProvider } from "../../../core/model-resolver.ts";
import { getSupportedThinkingLevels } from "../../../core/thinking-levels.ts";
import type { ModelListParams, ModelListResponse, Model as WireModel } from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";

type CatalogModel = PiModel<Api> & { readonly hidden?: boolean };
const DEFAULT_MODEL_IDS = new Map<string, string>(Object.entries(defaultModelPerProvider));

export function buildModelListResponse(models: readonly PiModel<Api>[], params: ModelListParams): ModelListResponse {
	const filteredModels = models
		.map((model) => buildWireModel(model))
		.filter((model) => params.includeHidden === true || !model.hidden);
	const start = parseModelListCursor(params.cursor, filteredModels.length);
	const limit = normalizeModelListLimit(params.limit, filteredModels.length);
	const end = Math.min(start + limit, filteredModels.length);
	return {
		data: filteredModels.slice(start, end),
		nextCursor: end < filteredModels.length ? String(end) : null,
	};
}

export function buildWireModel(model: CatalogModel): WireModel {
	return {
		id: `${model.provider}/${model.id}`,
		model: model.id,
		upgrade: null,
		upgradeInfo: null,
		availabilityNux: null,
		displayName: model.name ?? model.id,
		description: "",
		hidden: model.hidden === true,
		supportedReasoningEfforts: model.reasoning
			? getSupportedThinkingLevels(model)
					.filter((level) => level !== "off")
					.map((reasoningEffort) => ({ reasoningEffort, description: "" }))
			: [],
		defaultReasoningEffort: "medium",
		inputModalities: ["text"],
		supportsPersonality: false,
		additionalSpeedTiers: [],
		serviceTiers: [],
		defaultServiceTier: null,
		isDefault: DEFAULT_MODEL_IDS.get(model.provider) === model.id,
	};
}

function parseModelListCursor(cursor: string | null | undefined, total: number): number {
	if (cursor === undefined || cursor === null) return 0;
	const start = Number(cursor);
	if (!Number.isSafeInteger(start) || start < 0 || !/^\d+$/u.test(cursor)) {
		throw invalidModelListParams(`model/list received an invalid cursor: ${cursor}`);
	}
	if (start > total) {
		throw invalidModelListParams(`model/list cursor ${start} exceeds total models ${total}`);
	}
	return start;
}

function normalizeModelListLimit(limit: number | null | undefined, total: number): number {
	if (total === 0) return 0;
	if (limit === undefined || limit === null) return total;
	return Math.min(total, Math.max(1, limit));
}

function invalidModelListParams(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}
