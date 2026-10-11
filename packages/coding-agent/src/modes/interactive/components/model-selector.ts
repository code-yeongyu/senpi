import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ModelBlacklistAdapter, ModelBlacklistState } from "../../../core/extensions/types.ts";
import { ModelRegistry } from "../../../core/model-registry.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { createAmbientProviderCheck } from "../../../core/provider-default-selection.ts";
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

type ModelScope = "all" | "narrowed";
type ModelSelectorTui = Pick<TUI, "requestRender"> & { terminal?: { rows: number } };
type ModelSelectorSource = ModelRuntime | ModelRegistry;
type BlacklistStatusKind = "pending" | "saved" | "error";

function toModelItem(model: Model<any>): ModelItem {
	return { fullId: getModelFullId(model), provider: model.provider, id: model.id, model };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface ModelSelection {
	/** Also make it the default model for new sessions (the select-as-default key). */
	readonly asDefault: boolean;
}

export interface ModelSelectorFavoriteOptions {
	favoriteModelIds?: FavoriteModelIds;
	onFavoriteChange?: (
		favoriteModelIds: FavoriteModelIds,
		allModels: Model<any>[],
		toggledModel: Model<any>,
	) => void | Promise<void>;
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
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelSelectorSource;
	private onSelectCallback: (model: Model<any>, selection: ModelSelection) => void;
	private onCancelCallback: () => void;
	private favoriteIds: FavoriteModelIds = [];
	// Favorite membership snapshot taken when the selector opens. Ordering
	// (base sort and search partition) is frozen against this basis for the
	// whole session; live `favoriteIds` only drives markers and callbacks.
	private readonly favoriteIdsAtOpen: FavoriteModelIds;
	private onFavoriteChangeCallback?: ModelSelectorFavoriteOptions["onFavoriteChange"];
	// Native runtime policy by default; extensions may supply a picker adapter override.
	private readonly blacklist?: ModelBlacklistAdapter;
	private readonly blacklistStates = new Map<string, ModelBlacklistState>();
	// Models the runtime actually offers in this process. Blacklist-only rows are listed but never selectable.
	private availableIds = new Set<string>();
	private readonly pendingBlacklistIds = new Set<string>();
	private blacklistStatus?: { kind: BlacklistStatusKind; text: string };
	private errorMessage?: string;
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: ModelSelectorTui;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		tui: ModelSelectorTui,
		currentModel: Model<any> | undefined,
		// Kept for its callers: a selection no longer writes the default model itself (senpi#2870).
		_settingsManager: SettingsManager,
		modelRuntime: ModelSelectorSource,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>, selection: ModelSelection) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		favorites?: ModelSelectorFavoriteOptions,
		blacklist?: ModelBlacklistAdapter,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "narrowed" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.favoriteIds = favorites?.favoriteModelIds === null ? null : [...(favorites?.favoriteModelIds ?? [])];
		this.favoriteIdsAtOpen = this.favoriteIds === null ? null : [...this.favoriteIds];
		this.onFavoriteChangeCallback = favorites?.onFavoriteChange;
		this.blacklist = blacklist;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));
		const hints = [
			keyHint("tui.select.confirm", "select"),
			keyHint("app.models.save", "select as default"),
			keyHint("app.models.toggleFavorite", "favorite"),
		];
		if (this.blacklist) hints.push(keyHint("app.models.toggleBlacklist", "block/unblock (applies after restart)"));
		this.addChild(new Text(hints.join(" "), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model, { asDefault: false });
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
		const models = availableModels.map(toModelItem);
		this.availableIds = new Set(models.map((item) => item.fullId));
		// The blacklist adapter also lists models the runtime filtered out at startup; the runtime's own
		// (available) version of a model always wins over the adapter's copy.
		const listed = [...models];
		const listedIds = new Set(this.availableIds);
		for (const model of this.blacklist?.getModels() ?? []) {
			const item = toModelItem(model);
			if (listedIds.has(item.fullId)) continue;
			listedIds.add(item.fullId);
			listed.push(item);
		}
		this.refreshBlacklistStates(listed);
		this.allModels = this.sortModels(listed);
		const modelsById = new Map(models.map((model) => [model.fullId, model]));
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
		this.activeModels = this.scope === "narrowed" ? this.scopedModelItems : this.allModels;
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
			const highlighted = this.filteredModels[this.selectedIndex]?.fullId;
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.restoreHighlight(highlighted);
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
		const isAmbient = createAmbientProviderCheck(this.modelRuntime);
		// Sort: current model first, then favorites, then configured before ambient-only providers
		// (senpi#2327), then by provider/model.
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, a.fullId);
			const bIsFavorite = isFavoriteModel(this.favoriteIdsAtOpen, b.fullId);
			if (aIsFavorite && !bIsFavorite) return -1;
			if (!aIsFavorite && bIsFavorite) return 1;
			const ambientCompare = Number(isAmbient(a.provider)) - Number(isAmbient(b.provider));
			if (ambientCompare !== 0) return ambientCompare;
			const providerCompare = a.provider.localeCompare(b.provider);
			if (providerCompare !== 0) return providerCompare;
			return a.id.localeCompare(b.id);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const narrowedText = this.scope === "narrowed" ? theme.fg("accent", "narrowed") : theme.fg("muted", "narrowed");
		return `${theme.fg("muted", "Catalog: ")}${allText}${theme.fg("muted", " | ")}${narrowedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "catalog") + theme.fg("muted", " (all/narrowed)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "narrowed" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
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

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const favoriteMarker = isFavoriteModel(this.favoriteIds, item.fullId)
				? theme.fg("success", "* ")
				: theme.fg("dim", "  ");

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${favoriteMarker}${theme.fg("accent", item.id)}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix}${modelText} ${providerBadge}${checkmark}`;
			} else {
				const modelText = `  ${favoriteMarker}${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line + this.getBlacklistBadge(item), 0, 0));
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
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
		if (this.refreshStatusMessage) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
		if (this.blacklistStatus) {
			const color =
				this.blacklistStatus.kind === "error"
					? "error"
					: this.blacklistStatus.kind === "saved"
						? "success"
						: "muted";
			this.listContainer.addChild(new Spacer(1));
			for (const line of this.blacklistStatus.text.split("\n")) {
				this.listContainer.addChild(new Text(theme.fg(color, `  ${line}`), 0, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "narrowed" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
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
			if (selectedModel) {
				this.handleSelect(selectedModel.model, { asDefault: false });
			}
		}
		// Select and make it the default for new sessions (senpi#2870)
		else if (kb.matches(keyData, "app.models.save")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model, { asDefault: true });
			}
		}
		// Toggle favorite for selected model
		else if (kb.matches(keyData, "app.models.toggleFavorite")) {
			this.handleToggleFavorite();
		}
		// Block/unblock the highlighted model. Only claimed when a policy adapter is available, so the
		// chord keeps editing the search box otherwise.
		else if (this.blacklist && kb.matches(keyData, "app.models.toggleBlacklist")) {
			void this.handleToggleBlacklist();
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	// A selection applies to this session; only an explicit select-as-default changes the default for new sessions (senpi#2870).
	private handleSelect(model: Model<any>, selection: ModelSelection): void {
		const fullId = getModelFullId(model);
		if (!this.availableIds.has(fullId)) {
			// Listed through the blacklist adapter only: this process never loaded it.
			const reason = this.blacklistStates.get(fullId)?.activeBlocked ? "blocked when senpi started" : "not loaded";
			this.setBlacklistStatus(
				"error",
				`${fullId} is ${reason} and cannot be selected in this process. Restart senpi to use it.`,
			);
			return;
		}
		this.dispose();
		this.onSelectCallback(model, selection);
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

	private restoreHighlight(fullId: string | undefined): void {
		if (!fullId) return;
		const index = this.filteredModels.findIndex((item) => item.fullId === fullId);
		if (index < 0) return;
		this.selectedIndex = index;
		this.updateList();
	}

	private setBlacklistStatus(kind: BlacklistStatusKind, text: string): void {
		this.blacklistStatus = { kind, text };
		this.updateList();
		this.tui.requestRender();
	}

	private refreshBlacklistStates(items: readonly ModelItem[]): void {
		this.blacklistStates.clear();
		if (!this.blacklist) return;
		for (const item of items) this.blacklistStates.set(item.fullId, this.blacklist.getState(item.model));
	}

	private getBlacklistBadge(item: ModelItem): string {
		if (!this.blacklist) return "";
		if (this.pendingBlacklistIds.has(item.fullId)) return theme.fg("muted", " saving…");
		const state = this.blacklistStates.get(item.fullId);
		if (!state) return "";
		if (state.blocked && state.activeBlocked) return theme.fg("error", " blocked");
		if (state.blocked) return theme.fg("warning", " blocked (restart required)");
		if (state.activeBlocked) return theme.fg("warning", " unblocked (restart required)");
		return "";
	}

	// Persists through the adapter only. The running process keeps the models it loaded, so the result
	// always says whether a restart is still needed.
	private async handleToggleBlacklist(): Promise<void> {
		const adapter = this.blacklist;
		const target = this.filteredModels[this.selectedIndex];
		if (!adapter || !target || this.pendingBlacklistIds.has(target.fullId)) return;
		this.pendingBlacklistIds.add(target.fullId);
		this.setBlacklistStatus("pending", `Saving blacklist change for ${target.fullId}…`);
		try {
			await adapter.toggle(target.model);
		} catch (error) {
			this.pendingBlacklistIds.delete(target.fullId);
			if (this.closed) return;
			this.setBlacklistStatus("error", `Could not save blacklist change for ${target.fullId}: ${errorText(error)}`);
			return;
		}
		this.pendingBlacklistIds.delete(target.fullId);
		if (this.closed) return;
		// Re-read the saved state from a fresh snapshot, keeping whichever row is highlighted now.
		const highlighted = this.filteredModels[this.selectedIndex]?.fullId;
		this.loadModelsFromSnapshot();
		this.filterModels(this.searchInput.getValue());
		this.restoreHighlight(highlighted);
		const state = this.blacklistStates.get(target.fullId);
		const restart =
			state && state.blocked !== state.activeBlocked
				? " Restart senpi to apply it; this process keeps its current models."
				: "";
		this.setBlacklistStatus(
			"saved",
			`Saved ${target.fullId} as ${state?.blocked ? "blocked" : "unblocked"}.${restart}`,
		);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
