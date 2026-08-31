import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { ModelRegistry } from "../../../core/model-registry.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { rankModelSearchItems } from "../model-search-rank.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";
import { type FavoriteModelIds, getModelFullId, isFavoriteModel, toggleFavoriteModel } from "./model-favorites.ts";

interface ModelItem {
	fullId: string;
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "favorites" | "byModel" | "narrowed";
type ModelSelectorTui = Pick<TUI, "requestRender"> & { terminal?: { rows: number } };
type ModelSelectorSource = ModelRuntime | ModelRegistry;

export interface ModelSelectorFavoriteOptions {
	favoriteModelIds?: FavoriteModelIds;
	onFavoriteChange?: (
		favoriteModelIds: FavoriteModelIds,
		allModels: Model<any>[],
		toggledModel: Model<any>,
	) => void | Promise<void>;
}

export interface ModelSelectorCallabilityOptions {
	/** Models marked unavailable (access-denied); hidden from every view. */
	unavailableModelIds?: ReadonlySet<string>;
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private readonly hasConfiguredScope: boolean;
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRuntime: ModelSelectorSource;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private favoriteIds: FavoriteModelIds = [];
	// Favorite membership snapshot taken when the selector opens. Ordering
	// (base sort and search partition) is frozen against this basis for the
	// whole session; live `favoriteIds` only drives markers and callbacks.
	private readonly favoriteIdsAtOpen: FavoriteModelIds;
	private onFavoriteChangeCallback?: ModelSelectorFavoriteOptions["onFavoriteChange"];
	private readonly unavailableModelIds: ReadonlySet<string>;
	private hiddenUnavailableCount = 0;
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: ModelSelectorTui;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private expandedModelGroup?: string;
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: ModelSelectorTui,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRuntime: ModelSelectorSource,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		favorites?: ModelSelectorFavoriteOptions,
		callability?: ModelSelectorCallabilityOptions,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.hasConfiguredScope = scopedModels.length > 0;
		this.scope = scopedModels.length > 0 ? "narrowed" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.favoriteIds = favorites?.favoriteModelIds === null ? null : [...(favorites?.favoriteModelIds ?? [])];
		this.favoriteIdsAtOpen = this.favoriteIds === null ? null : [...this.favoriteIds];
		this.onFavoriteChangeCallback = favorites?.onFavoriteChange;
		this.unavailableModelIds = callability?.unavailableModelIds ?? new Set();

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		this.scopeText = new Text(this.getScopeText(), 0, 0);
		this.addChild(this.scopeText);
		this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		this.addChild(this.scopeHintText);
		if (scopedModels.length === 0) {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				`${keyHint("tui.select.confirm", "select")} ${keyHint("app.models.toggleFavorite", "favorite")}`,
				0,
				0,
			),
		);
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Render the current snapshot immediately, then refresh in the background.
		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		void this.refreshModels();
	}

	private loadModelsFromSnapshot(): void {
		const availableModels =
			this.modelRuntime instanceof ModelRegistry
				? this.modelRuntime.getAvailable()
				: this.modelRuntime.getAvailableSnapshot();
		const models = availableModels.map((model: Model<any>) => ({
			fullId: getModelFullId(model),
			provider: model.provider,
			id: model.id,
			model,
		}));
		const visibleModels = models.filter((item) => !this.unavailableModelIds.has(item.fullId));
		this.hiddenUnavailableCount = models.length - visibleModels.length;
		this.allModels = this.sortModels(visibleModels);
		const modelsById = new Map(visibleModels.map((model) => [model.fullId, model]));
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed =
				this.modelRuntime instanceof ModelRegistry
					? this.modelRuntime.find(scoped.model.provider, scoped.model.id)
					: this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.flatMap((scoped) => {
			const refreshed = modelsById.get(`${scoped.model.provider}/${scoped.model.id}`);
			return refreshed ? [refreshed] : [];
		});
		this.activeModels = this.computeActiveModels();
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async refreshModels(): Promise<void> {
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			let result: { aborted: boolean; errors: ReadonlyMap<string, Error> };
			if (this.modelRuntime instanceof ModelRegistry) {
				await this.modelRuntime.refresh();
				result = { aborted: false, errors: new Map() };
			} else {
				result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			}
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, then favorites, then by provider/model.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, a.fullId);
			const bIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, b.fullId);
			if (aIsFavorite && !bIsFavorite) return -1;
			if (!aIsFavorite && bIsFavorite) return 1;
			const providerCompare = a.provider.localeCompare(b.provider);
			if (providerCompare !== 0) return providerCompare;
			return a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private availableScopes(): ModelScope[] {
		const scopes: ModelScope[] = ["all", "favorites", "byModel"];
		if (this.hasConfiguredScope) scopes.push("narrowed");
		return scopes;
	}

	private getScopeText(): string {
		const labels: Record<ModelScope, string> = {
			all: "all",
			favorites: "favorites",
			byModel: "by-model",
			narrowed: "narrowed",
		};
		const parts = this.availableScopes().map((scope) =>
			scope === this.scope ? theme.fg("accent", labels[scope]) : theme.fg("muted", labels[scope]),
		);
		return `${theme.fg("muted", "Catalog: ")}${parts.join(theme.fg("muted", " | "))}`;
	}

	private getScopeHintText(): string {
		const labels = this.availableScopes().map((scope) => (scope === "byModel" ? "by-model" : scope));
		return keyHint("tui.input.tab", "catalog") + theme.fg("muted", ` (${labels.join("/")})`);
	}

	/** Group the full catalog by model id so one row represents every provider lane. */
	private groupByModelId(): Map<string, ModelItem[]> {
		const groups = new Map<string, ModelItem[]>();
		for (const item of this.allModels) {
			const group = groups.get(item.id);
			if (group) group.push(item);
			else groups.set(item.id, [item]);
		}
		return groups;
	}

	private computeActiveModels(): ModelItem[] {
		switch (this.scope) {
			case "narrowed":
				return this.scopedModelItems;
			case "favorites":
				return this.allModels.filter((item) => isFavoriteModel(this.favoriteIdsAtOpen, item.fullId));
			case "byModel": {
				if (this.expandedModelGroup !== undefined) {
					return this.groupByModelId().get(this.expandedModelGroup) ?? [];
				}
				// Representative per group: allModels order already prefers the
				// current model, then favorites, then provider/id alphabetical.
				return [...this.groupByModelId().values()].flatMap((group) => {
					const representative = group[0];
					return representative === undefined ? [] : [representative];
				});
			}
			default:
				return this.allModels;
		}
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope && this.expandedModelGroup === undefined) return;
		this.scope = scope;
		this.expandedModelGroup = undefined;
		this.activeModels = this.computeActiveModels();
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
		if (this.scopeHintText) {
			this.scopeHintText.setText(this.getScopeHintText());
		}
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? rankModelSearchItems(
					this.activeModels,
					query,
					({ id, provider, model }) => ({ id, provider, name: model.name }),
					{
						favoritesFirst: this.scope === "all",
						isFavorite: (item) => isFavoriteModel(this.favoriteIdsAtOpen, item.fullId),
					},
				)
			: this.activeModels;
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		// Window long registries using the same viewport-aware sizing as the
		// extension selector, while retaining a stable fallback for test doubles.
		const maxVisible = this.tui.terminal ? Math.max(5, Math.floor(this.tui.terminal.rows / 2)) : 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		if (startIndex > 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  … ${startIndex} more above`), 0, 0));
		}

		const groupSizes = new Map<string, number>();
		if (this.scope === "byModel" && this.expandedModelGroup === undefined) {
			for (const [id, group] of this.groupByModelId()) groupSizes.set(id, group.length);
		}

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const favoriteMarker = isFavoriteModel(this.favoriteIds, item.fullId)
				? theme.fg("success", "* ")
				: theme.fg("dim", "  ");

			const groupSize = groupSizes.get(item.id) ?? 1;
			const providerBadge = theme.fg("muted", groupSize > 1 ? `[${groupSize} providers]` : `[${item.provider}]`);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${favoriteMarker}${theme.fg("accent", item.id)}`;
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix}${modelText} ${providerBadge}${checkmark}`;
			} else {
				const modelText = `  ${favoriteMarker}${item.id}`;
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		if (endIndex < this.filteredModels.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  … ${this.filteredModels.length - endIndex} more below`), 0, 0),
			);
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			const emptyText =
				this.scope === "favorites" && !this.searchInput.getValue()
					? `  No favorite models yet — ${keyHint("app.models.toggleFavorite", "favorite")} to mark one`
					: "  No matching models";
			this.listContainer.addChild(new Text(theme.fg("muted", emptyText), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
		if (this.hiddenUnavailableCount > 0) {
			this.listContainer.addChild(
				new Text(
					theme.fg(
						"muted",
						`  ${this.hiddenUnavailableCount} unavailable model(s) hidden (access denied; auto-restores within 24h)`,
					),
					0,
					0,
				),
			);
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			const scopes = this.availableScopes();
			const nextScope = scopes[(scopes.indexOf(this.scope) + 1) % scopes.length] ?? "all";
			this.setScope(nextScope);
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (!selectedModel) return;
			if (this.scope === "byModel" && this.expandedModelGroup === undefined) {
				const group = this.groupByModelId().get(selectedModel.id) ?? [];
				if (group.length > 1) {
					// Drill into the provider lanes of a multi-provider model id.
					this.expandedModelGroup = selectedModel.id;
					this.activeModels = group;
					this.selectedIndex = 0;
					this.filterModels(this.searchInput.getValue());
					return;
				}
			}
			this.handleSelect(selectedModel.model);
		}
		// Toggle favorite for selected model
		else if (kb.matches(keyData, "app.models.toggleFavorite")) {
			this.handleToggleFavorite();
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.expandedModelGroup !== undefined) {
				// Pop back out of a provider drill-down instead of closing.
				const groupKey = this.expandedModelGroup;
				this.expandedModelGroup = undefined;
				this.activeModels = this.computeActiveModels();
				this.filterModels(this.searchInput.getValue());
				const groupIndex = this.filteredModels.findIndex((item) => item.id === groupKey);
				if (groupIndex >= 0) {
					this.selectedIndex = groupIndex;
					this.updateList();
				}
				return;
			}
			this.dispose();
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.dispose();
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	private handleToggleFavorite(): void {
		const selectedModel = this.filteredModels[this.selectedIndex];
		if (!selectedModel) return;

		const allModelIds = this.allModels.map((model) => model.fullId);
		this.favoriteIds = toggleFavoriteModel(this.favoriteIds, allModelIds, selectedModel.fullId);
		// Row order is frozen for the session: no re-sort here. The marker
		// re-renders from live favoriteIds via filterModels/updateList.
		this.filterModels(this.searchInput.getValue());
		const selectedIndex = this.filteredModels.findIndex((item) => item.fullId === selectedModel.fullId);
		if (selectedIndex >= 0) {
			this.selectedIndex = selectedIndex;
			this.updateList();
		}
		const nextFavoriteIds = this.favoriteIds === null ? null : [...this.favoriteIds];
		void this.onFavoriteChangeCallback?.(
			nextFavoriteIds,
			this.allModels.map((item) => item.model),
			selectedModel.model,
		);
		this.tui.requestRender();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
