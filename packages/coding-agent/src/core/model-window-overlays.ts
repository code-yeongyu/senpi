import { normalizeProviderId, type Api, type Model } from "@earendil-works/pi-ai";

// A selected snapshot can outlive the generation that proposed its window.
export const modelsWithWindowOverlay = new WeakSet<Model<Api>>();

type ModelWindowContribution = {
	readonly provider: string;
	readonly windows: ReadonlyMap<string, number>;
};

/** Window contributions owned by one session's extension generation. */
export class ModelWindowOverlays {
	private readonly providers = new Map<string, Map<object, ReadonlyMap<string, number>>>();

	prepare(providerId: string, windows: Readonly<Record<string, number>>): ModelWindowContribution {
		const provider = normalizeProviderId(providerId);
		if (!provider.trim()) throw new Error("Model window provider must not be empty.");
		const entries = Object.entries(windows);
		for (const [id, window] of entries) {
			if (!id.trim() || !Number.isSafeInteger(window) || window <= 0) {
				throw new Error(`Invalid context window for model "${id}".`);
			}
		}
		return { provider, windows: new Map(entries) };
	}

	replace(owner: object, contribution: ModelWindowContribution): void {
		const { provider, windows } = contribution;
		const owners = this.providers.get(provider) ?? new Map<object, ReadonlyMap<string, number>>();
		owners.delete(owner);
		if (windows.size > 0) owners.set(owner, windows);
		if (owners.size > 0) this.providers.set(provider, owners);
		else this.providers.delete(provider);
	}

	get(providerId: string, modelId: string): number | undefined {
		const owners = this.providers.get(normalizeProviderId(providerId));
		if (!owners) return undefined;
		let result: number | undefined;
		for (const windows of owners.values()) {
			const value = windows.get(modelId);
			if (value !== undefined) {
				result = value;
			}
		}
		return result;
	}

	clear(): void {
		this.providers.clear();
	}
}

/** Reuse unchanged projected models without hiding in-place changes to their metadata. */
export class ModelWindowProjection {
	private readonly models = new WeakMap<Model<Api>, Model<Api>>();

	apply(model: Model<Api>, window: number): Model<Api> {
		if (window === model.contextWindow) return model;
		const cached = this.models.get(model);
		if (cached?.contextWindow === window && this.matches(model, cached)) return cached;
		const projected = { ...model, contextWindow: window };
		this.models.set(model, projected);
		return projected;
	}

	private matches(source: Model<Api>, projected: Model<Api>): boolean {
		const sourceKeys = Reflect.ownKeys(source).filter((key) =>
			Object.prototype.propertyIsEnumerable.call(source, key),
		);
		const projectedKeys = Reflect.ownKeys(projected).filter((key) =>
			Object.prototype.propertyIsEnumerable.call(projected, key),
		);
		return (
			sourceKeys.length === projectedKeys.length &&
			sourceKeys.every(
				(key) =>
					Object.prototype.propertyIsEnumerable.call(projected, key) &&
					(key === "contextWindow" || Object.is(Reflect.get(source, key), Reflect.get(projected, key))),
			)
		);
	}
}
