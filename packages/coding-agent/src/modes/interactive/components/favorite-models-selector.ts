import type { Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyText } from "./keybinding-hints.js";

// FavoriteIds: null = all favorite, string[] = explicit ordered list
type FavoriteIds = string[] | null;

function isFavorite(favoriteIds: FavoriteIds, id: string): boolean {
	return favoriteIds === null || favoriteIds.includes(id);
}

function toggleFavorite(favoriteIds: FavoriteIds, id: string): FavoriteIds {
	if (favoriteIds === null) return [id]; // First toggle: start with only this one
	const index = favoriteIds.indexOf(id);
	if (index >= 0) return [...favoriteIds.slice(0, index), ...favoriteIds.slice(index + 1)];
	return [...favoriteIds, id];
}

function favoriteAll(favoriteIds: FavoriteIds, allIds: string[], targetIds?: string[]): FavoriteIds {
	if (favoriteIds === null) return null; // Already all favorite
	const targets = targetIds ?? allIds;
	const result = [...favoriteIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length ? null : result;
}

function clearAll(favoriteIds: FavoriteIds, allIds: string[], targetIds?: string[]): FavoriteIds {
	if (favoriteIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? favoriteIds);
	return favoriteIds.filter((id) => !targets.has(id));
}

function move(favoriteIds: FavoriteIds, id: string, delta: number): FavoriteIds {
	if (favoriteIds === null) return null;
	const list = [...favoriteIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

function getSortedIds(favoriteIds: FavoriteIds, allIds: string[]): string[] {
	if (favoriteIds === null) return allIds;
	const favoriteSet = new Set(favoriteIds);
	return [...favoriteIds, ...allIds.filter((id) => !favoriteSet.has(id))];
}

interface ModelItem {
	fullId: string;
	model: Model<any>;
	favorite: boolean;
}

function getModelSearchText(item: ModelItem): string {
	return `${item.fullId} ${item.model.id} ${item.model.name} ${item.model.provider}`;
}

export interface FavoriteModelsConfig {
	allModels: Model<any>[];
	favoriteModelIds: string[] | null;
}

export interface FavoriteModelsCallbacks {
	/** Called whenever the favorite model set or order changes (session-only, no persist) */
	onChange: (favoriteModelIds: string[] | null) => void | Promise<void>;
	/** Called when user wants to persist current selection to settings */
	onPersist: (favoriteModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * Component for managing favorite models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class FavoriteModelsSelectorComponent extends Container implements Focusable {
	private modelsById: Map<string, Model<any>> = new Map();
	private allIds: string[] = [];
	private favoriteIds: FavoriteIds = null;
	private filteredItems: ModelItem[] = [];
	private selectedIndex = 0;
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
	private footerText: Text;
	private callbacks: FavoriteModelsCallbacks;
	private maxVisible = 8;
	private isDirty = false;

	constructor(config: FavoriteModelsConfig, callbacks: FavoriteModelsCallbacks) {
		super();
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		this.favoriteIds = config.favoriteModelIds === null ? null : [...config.favoriteModelIds];
		this.filteredItems = this.buildItems();

		// Header
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Favorite Models")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer hint
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());
		this.updateList();
	}

	private buildItems(): ModelItem[] {
		// Filter out IDs that no longer have a corresponding model (e.g., after logout)
		const items: ModelItem[] = [];
		for (const id of getSortedIds(this.favoriteIds, this.allIds)) {
			const model = this.modelsById.get(id);
			if (!model) continue;
			items.push({
				fullId: id,
				model,
				favorite: isFavorite(this.favoriteIds, id),
			});
		}
		return items;
	}

	private getFooterText(): string {
		const favoriteCount = this.favoriteIds?.length ?? this.allIds.length;
		const allFavorite = this.favoriteIds === null;
		const countText = allFavorite ? "all favorites" : `${favoriteCount}/${this.allIds.length} favorites`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("app.models.enableAll")} favorite all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query ? fuzzyFilter(items, query, getModelSearchText) : items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private notifyChange(): void {
		this.callbacks.onChange(this.favoriteIds === null ? null : [...this.favoriteIds]);
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		const allFavorite = this.favoriteIds === null;

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? theme.fg("accent", item.model.id) : item.model.id;
			const providerBadge = theme.fg("muted", ` [${item.model.provider}]`);
			const status = allFavorite ? "" : item.favorite ? theme.fg("success", " ✓") : theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${status}`, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		if (this.filteredItems.length > 0) {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
			}
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Navigation
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Reorder favorite models
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.favoriteIds === null) return;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isFavorite(this.favoriteIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.favoriteIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				// Only move if within bounds
				if (newIndex >= 0 && newIndex < this.favoriteIds.length) {
					this.favoriteIds = move(this.favoriteIds, item.fullId, delta);
					this.isDirty = true;
					this.selectedIndex += delta;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		// Toggle on Enter
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.favoriteIds = toggleFavorite(this.favoriteIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Favorite all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.favoriteIds = favoriteAll(this.favoriteIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Clear all (filtered if search active, otherwise all)
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.favoriteIds = clearAll(this.favoriteIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// Toggle provider of current item
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)?.provider === provider);
				const allFavorite = providerIds.every((id) => isFavorite(this.favoriteIds, id));
				this.favoriteIds = allFavorite
					? clearAll(this.favoriteIds, this.allIds, providerIds)
					: favoriteAll(this.favoriteIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// Save/persist to settings
		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.favoriteIds === null ? null : [...this.favoriteIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C - clear search or cancel if empty
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		// Escape - cancel
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		// Pass everything else to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
