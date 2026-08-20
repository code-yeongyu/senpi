import type { Component, Focusable } from "@earendil-works/pi-tui";
import type { Theme } from "../../../../modes/interactive/theme/theme.ts";
import type { KeybindingsManager } from "../../../keybindings.ts";
import type { BtwHistoryEntry } from "./history.ts";
import type { BtwSideCallbacks } from "./side-controller.ts";

export interface BtwSideEditorPort extends Component, Focusable {
	disableSubmit: boolean;
	onSubmit?: (text: string) => void;
	getText(): string;
	setText(text: string): void;
	handleInput(data: string): void;
	addToHistory?(text: string): void;
}

export interface BtwSidePanelTui {
	readonly terminal: { readonly rows: number };
	requestRender(): void;
}

export interface BtwSidePanelOptions {
	readonly entries: readonly BtwHistoryEntry[];
	readonly tui: BtwSidePanelTui;
	readonly theme: Theme;
	readonly keybindings: KeybindingsManager;
	readonly callbacks: BtwSideCallbacks;
	readonly createEditor: () => BtwSideEditorPort;
}
