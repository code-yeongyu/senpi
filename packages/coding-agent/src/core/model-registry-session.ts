import { isModelType, type AnyModel, type Api, type Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "./model-registry.ts";

type ModelItem<T> = T extends readonly (infer Item)[] ? Item : T;

// Keep this exhaustive for model reads, including typed reads that can return chat models.
// Projection controls belong to the session rather than the injected registry.
type SessionRegistryMethods = {
	[
		K in keyof ModelRegistry as K extends "setModelWindowOverlays" | "projectModel"
			? K
			: ModelRegistry[K] extends (...args: never[]) => infer Result
				? Extract<ModelItem<Awaited<Result>>, Model<Api>> extends never
					? never
					: K
				: never
	]: ModelRegistry[K];
};

/** A session-local view that retains custom behavior on the supplied registry. */
export function createSessionModelRegistry(target: ModelRegistry, session: ModelRegistry): ModelRegistry {
	function project<T extends AnyModel>(model: T): T;
	function project(model: AnyModel): AnyModel {
		return isModelType(model, "chat") ? session.projectModel(model) : model;
	}
	const methods: SessionRegistryMethods = {
		setModelWindowOverlays: session.setModelWindowOverlays.bind(session),
		projectModel: session.projectModel.bind(session),
		getAll: (options) => {
			const models = target.getAll(options);
			return options?.includeWindowOverlays === false ? models : models.map(project);
		},
		getAvailable: () => target.getAvailable().map(project),
		find: (provider, id) => {
			const model = target.find(provider, id);
			return model === undefined ? undefined : project(model);
		},
		findOfType: (type, provider, id) => {
			const model = target.findOfType(type, provider, id);
			return model === undefined ? undefined : project(model);
		},
		getModelOfType: (type, provider, id) => {
			const model = target.getModelOfType(type, provider, id);
			return model === undefined ? undefined : project(model);
		},
		getModelsOfType: (type, provider) => target.getModelsOfType(type, provider).map(project),
		getAvailableOfType: async (type, provider, options) =>
			(await target.getAvailableOfType(type, provider, options)).map(project),
	};
	const boundMethods = new WeakMap<object, unknown>();
	return new Proxy(target, {
		get(target, key) {
			if (Object.hasOwn(methods, key)) return Reflect.get(methods, key);
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function" || key === "constructor") return value;
			const bound = boundMethods.get(value) ?? value.bind(target);
			boundMethods.set(value, bound);
			return bound;
		},
	});
}
