import type { BtwHistoryEntry } from "./history.ts";

export interface BtwSidePanelPort {
	startTurn(question: string): void;
	appendText(delta: string): void;
	completeTurn(entry: BtwHistoryEntry): void;
	failTurn(message: string): void;
	abortTurn(): void;
	setParentStatus(status: "working" | "idle"): void;
}

export interface BtwSideOverlayHandle {
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	focus(): void;
	unfocus(): void;
}

export interface BtwSideSurface {
	readonly panel: BtwSidePanelPort;
	readonly handle: BtwSideOverlayHandle;
	close(): void;
}

export interface BtwSideCallbacks {
	onSubmit(question: string): void;
	onToggle(): void;
	onClose(): void;
	onInterrupt(): void;
}

export interface BtwSideQuestionInput {
	readonly question: string;
	readonly signal: AbortSignal;
	readonly onTextDelta: (delta: string) => void;
}

export interface BtwSideControllerOpenOptions {
	readonly createSurface: (callbacks: BtwSideCallbacks) => Promise<BtwSideSurface>;
	readonly runQuestion: (input: BtwSideQuestionInput) => Promise<string>;
	readonly persist: (entry: BtwHistoryEntry) => void;
	readonly notify: (message: string, type: "info" | "warning" | "error") => void;
	readonly setStatus: (text: string | undefined) => void;
	readonly initialParentStatus: "working" | "idle";
}
