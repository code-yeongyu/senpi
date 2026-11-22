import { type Context, defineFacet, type Facet, type MutableReplicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentLane, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { Models, type Models as ModelsService, type ModelsState } from "./models.ts";

export interface ModelsServiceRuntime {
	readonly service: ModelsService;
	activate(context: Context): Promise<void>;
}

export function createModelsService(
	lane: AgentLane,
	modelRuntime: ModelRuntime | undefined,
	settingsManager: SettingsManager | undefined,
	createState: (initial: ModelsState) => MutableReplicatedState<ModelsState>,
): ModelsServiceRuntime {
	let catalogRevision = 0;
	const state = createState({
		catalog: { revision: 0, availableModels: [] },
		configuration: { model: null, thinkingLevel: "off" },
		refresh: { status: "idle" },
	});
	const readConfiguration = async (context: Context): Promise<ModelsState["configuration"]> => {
		const [selected, thinkingLevel] = await Promise.all([lane.getModel(context), lane.getThinkingLevel(context)]);
		return {
			model: selected === undefined ? null : { provider: selected.provider, modelId: selected.id },
			thinkingLevel,
		};
	};
	const readThinkingLevels = async (context: Context): Promise<ThinkingLevel[]> => {
		const selected = await lane.getModel(context);
		return selected === undefined ? ["off"] : getSupportedThinkingLevels(selected);
	};
	const readCatalog = async (context: Context): Promise<ModelsState["catalog"]> => {
		const selected = await lane.getModel(context);
		const available = modelRuntime?.getAvailableSnapshot() ?? [];
		const catalog =
			selected === undefined || includesModel(available, selected) ? available : [...available, selected];
		catalogRevision += 1;
		return {
			revision: catalogRevision,
			availableModels: catalog.map((model) => ({
				provider: model.provider,
				modelId: model.id,
				name: model.name,
				reasoning: model.reasoning,
			})),
		};
	};
	const service: ModelsService = {
		state,
		async cycleThinking(context) {
			const levels = await readThinkingLevels(context);
			const current = await lane.getThinkingLevel(context);
			const index = levels.indexOf(current);
			const next = levels[(index + 1) % levels.length] ?? "off";
			await lane.setThinkingLevel(next, context);
			const configuration = await readConfiguration(context);
			state.change(context, (draft) => {
				draft.configuration = configuration;
			});
		},
		async getThinkingLevels(context) {
			return [...(await readThinkingLevels(context))];
		},
		async refresh(context) {
			state.change(context, (draft) => {
				draft.refresh = { status: "refreshing" };
			});
			const refresh = modelRuntime?.refresh({ signal: context.abortSignal });
			if (refresh === undefined) {
				const [catalog, configuration] = await Promise.all([readCatalog(context), readConfiguration(context)]);
				state.change(context, (draft) => {
					draft.catalog = catalog;
					draft.configuration = configuration;
					draft.refresh = { status: "done" };
				});
				return;
			}
			const result = await refresh;
			const errors = Object.fromEntries([...result.errors].map(([id, error]) => [id, error.message]));
			const [catalog, configuration] = await Promise.all([readCatalog(context), readConfiguration(context)]);
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.configuration = configuration;
				draft.refresh = Object.keys(errors).length === 0 ? { status: "done" } : { status: "warning", errors };
			});
		},
		async select(model, context) {
			const selected = modelRuntime?.getModel(model.provider, model.modelId);
			if (selected === undefined) throw new Error(`Unknown model: ${model.provider}/${model.modelId}`);
			await lane.setModel({ provider: selected.provider, modelId: selected.id }, context);
			settingsManager?.setDefaultModelAndProvider(selected.provider, selected.id);
			await settingsManager?.flush();
			const configuration = await readConfiguration(context);
			state.change(context, (draft) => {
				draft.configuration = configuration;
			});
		},
		async selectThinking(level, context) {
			const levels = await readThinkingLevels(context);
			if (!levels.includes(level)) {
				throw new Error(`Thinking level ${level} is unavailable; choose one of: ${levels.join(", ")}`);
			}
			await lane.setThinkingLevel(level, context);
			const configuration = await readConfiguration(context);
			state.change(context, (draft) => {
				draft.configuration = configuration;
			});
		},
	};
	return {
		service,
		async activate(context) {
			const [catalog, configuration] = await Promise.all([readCatalog(context), readConfiguration(context)]);
			state.change(context, (draft) => {
				draft.catalog = catalog;
				draft.configuration = configuration;
				draft.refresh = { status: "idle" };
			});
		},
	};
}

export function createModelsServiceFacet(options: {
	readonly lane: AgentLane;
	readonly modelRuntime: ModelRuntime | undefined;
	readonly settingsManager?: SettingsManager;
}): Facet {
	return defineFacet({
		id: "@pi/models",
		setup(env) {
			const runtime = createModelsService(
				options.lane,
				options.modelRuntime,
				options.settingsManager,
				env.replicatedState,
			);
			env.provide(Models, runtime.service);
			env.onActivate(() => runtime.activate(BACKGROUND_CONTEXT));
		},
	});
}

function includesModel(
	models: readonly { readonly provider: string; readonly id: string }[],
	selected: { readonly provider: string; readonly id: string },
): boolean {
	return models.some((model) => model.provider === selected.provider && model.id === selected.id);
}
