import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";

const MODEL_CAPABILITY_FIELDS = [
	"contextWindow",
	"maxTokens",
	"input",
	"reasoning",
	"thinkingLevelMap",
	"upstreamModelId",
	"serviceTier",
	"recoverTextToolCalls",
	"compat",
] as const;

type ModelCapabilityField = (typeof MODEL_CAPABILITY_FIELDS)[number];

export type RemoteCatalogConflict = {
	readonly providerId: string;
	readonly modelId: string;
	readonly fields: readonly ModelCapabilityField[];
};

type RemoteCatalogMerge = {
	readonly models: Model<Api>[];
	readonly conflicts: readonly RemoteCatalogConflict[];
};

export function mergeRemoteCatalogModels(
	providerId: string,
	baseline: readonly Model<Api>[],
	dynamic: readonly Model<Api>[],
): RemoteCatalogMerge {
	const merged = [...baseline];
	const conflicts: RemoteCatalogConflict[] = [];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index < 0) {
			merged.push(model);
			continue;
		}
		const staticModel = merged[index];
		const fields = MODEL_CAPABILITY_FIELDS.filter((field) => !isDeepStrictEqual(staticModel[field], model[field]));
		if (fields.length > 0) conflicts.push({ providerId, modelId: model.id, fields });
		merged[index] = { ...staticModel, name: model.name, cost: model.cost };
	}
	return { models: merged, conflicts };
}

export function parseRemoteCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries?.every(isModelCatalogEntry)) {
		throw new Error(`Invalid model catalog for provider "${providerId}"`);
	}
	return entries.map((model) => ({ ...model, provider: providerId }));
}

function isModelCatalogEntry(value: unknown): value is Model<Api> {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.api === "string" &&
		typeof value.provider === "string" &&
		typeof value.baseUrl === "string" &&
		typeof value.reasoning === "boolean" &&
		isInputArray(value.input) &&
		isModelCost(value.cost) &&
		isFiniteNumber(value.contextWindow) &&
		isFiniteNumber(value.maxTokens)
	);
}

function isInputArray(value: unknown): value is Model<Api>["input"] {
	return (
		Array.isArray(value) &&
		value.every((modality) => modality === "text" || modality === "image" || modality === "video")
	);
}

function isModelCost(value: unknown): value is Model<Api>["cost"] {
	if (!isRecord(value)) return false;
	return (
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite)
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
