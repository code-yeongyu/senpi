import type { Api, Model } from "@earendil-works/pi-ai";

const FAST_MODEL_SUFFIX = "-fast";

/** The catalog reads that decide whether a `-fast` id is the priority-tier twin of a base model. */
export interface FastPairRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getUpstreamModelId(model: Model<Api>): string | undefined;
	getServiceTier(model: Model<Api>): string | undefined;
}

function requestModelId(registry: FastPairRegistry, model: Model<Api>): string {
	return registry.getUpstreamModelId(model) ?? model.id;
}

function isCompatibleFastVariant(registry: FastPairRegistry, baseModel: Model<Api>, fastModel: Model<Api>): boolean {
	return (
		fastModel.provider === baseModel.provider &&
		fastModel.api === baseModel.api &&
		registry.getServiceTier(fastModel) === "priority" &&
		requestModelId(registry, fastModel) === requestModelId(registry, baseModel)
	);
}

/** The base model a `-fast` catalog variant is served as (same provider, same request id, priority tier). */
export function findBaseModel(registry: FastPairRegistry, fastModel: Model<Api>): Model<Api> | undefined {
	if (!fastModel.id.endsWith(FAST_MODEL_SUFFIX)) return undefined;
	const baseModel = registry.find(fastModel.provider, fastModel.id.slice(0, -FAST_MODEL_SUFFIX.length));
	return baseModel && isCompatibleFastVariant(registry, baseModel, fastModel) ? baseModel : undefined;
}

/** The `-fast` catalog variant of a base model, when the catalog pairs them. */
export function findFastModel(registry: FastPairRegistry, baseModel: Model<Api>): Model<Api> | undefined {
	if (baseModel.id.endsWith(FAST_MODEL_SUFFIX)) return undefined;
	const fastModel = registry.find(baseModel.provider, `${baseModel.id}${FAST_MODEL_SUFFIX}`);
	return fastModel && isCompatibleFastVariant(registry, baseModel, fastModel) ? fastModel : undefined;
}

/** A registry that may lack the catalog reads (test doubles); without them no sibling is ever paired. */
export interface PartialFastPairRegistry {
	find(provider: string, id: string): Model<Api> | undefined;
	getUpstreamModelId?(model: Model<Api>): string | undefined;
	getServiceTier?(model: Model<Api>): string | undefined;
}

/** `resolveChainKey`'s option naming the current model's `-fast` sibling, when the catalog has one. */
export function fastSiblingOption(registry: PartialFastPairRegistry, model: Model<Api>): { fastSibling?: Model<Api> } {
	const { getUpstreamModelId, getServiceTier } = registry;
	if (!getUpstreamModelId || !getServiceTier) return {};
	const fastSibling = findFastModel(
		{
			find: (provider, id) => registry.find(provider, id),
			getUpstreamModelId: (m) => getUpstreamModelId.call(registry, m),
			getServiceTier: (m) => getServiceTier.call(registry, m),
		},
		model,
	);
	return fastSibling ? { fastSibling } : {};
}
