import type { BtwHistoryEntry } from "./history.ts";
import type { BtwSideControllerOpenOptions, BtwSideSurface } from "./side-controller-types.ts";

export type {
	BtwSideCallbacks,
	BtwSideControllerOpenOptions,
	BtwSideOverlayHandle,
	BtwSidePanelPort,
	BtwSideQuestionInput,
	BtwSideSurface,
} from "./side-controller-types.ts";

interface OpenSide {
	readonly lifetime: AbortController;
	readonly options: BtwSideControllerOpenOptions;
	surface: BtwSideSurface | undefined;
	request: AbortController | undefined;
	visible: boolean;
	parentStatus: "working" | "idle";
}

const HIDDEN_STATUS = "BTW side open · Ctrl+/ to return";

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	const text = String(error).trim();
	return text.length > 0 ? text : fallback;
}

export class BtwSideController {
	#side: OpenSide | undefined;

	get isOpen(): boolean {
		return this.#side !== undefined;
	}

	get isVisible(): boolean {
		return this.#side?.visible ?? false;
	}

	get isBusy(): boolean {
		return this.#side?.request !== undefined;
	}

	async open(options: BtwSideControllerOpenOptions, initialQuestion?: string): Promise<void> {
		const existing = this.#side;
		if (existing !== undefined) {
			this.show();
			if (initialQuestion !== undefined) this.#submit(existing, initialQuestion);
			return;
		}

		const side: OpenSide = {
			lifetime: new AbortController(),
			options,
			surface: undefined,
			request: undefined,
			visible: true,
			parentStatus: options.initialParentStatus,
		};
		this.#side = side;

		try {
			const surface = await options.createSurface({
				onSubmit: (question) => this.#submit(side, question),
				onToggle: () => this.toggle(),
				onClose: () => this.close(),
				onInterrupt: () => this.interrupt(),
			});
			if (this.#side !== side || side.lifetime.signal.aborted) {
				surface.close();
				return;
			}
			side.surface = surface;
			surface.panel.setParentStatus(side.parentStatus);
			if (initialQuestion !== undefined) this.#submit(side, initialQuestion);
		} catch (error) {
			if (this.#side !== side) return;
			this.#side = undefined;
			options.setStatus(undefined);
			options.notify(errorMessage(error, "Unable to open the side conversation."), "error");
		}
	}

	toggle(): void {
		if (this.#side?.visible === true) this.hide();
		else this.show();
	}

	hide(): void {
		const side = this.#side;
		if (side?.surface === undefined || !side.visible) return;
		side.visible = false;
		side.surface.handle.setHidden(true);
		side.surface.handle.unfocus();
		side.options.setStatus(HIDDEN_STATUS);
	}

	show(): void {
		const side = this.#side;
		if (side?.surface === undefined || side.visible) return;
		side.visible = true;
		side.surface.handle.setHidden(false);
		side.surface.handle.focus();
		side.options.setStatus(undefined);
	}

	interrupt(): void {
		const side = this.#side;
		const request = side?.request;
		if (side === undefined || request === undefined) return;
		side.request = undefined;
		request.abort(new Error("BTW side answer interrupted"));
		side.surface?.panel.abortTurn();
	}

	close(): void {
		const side = this.#side;
		if (side === undefined) return;
		this.#side = undefined;
		side.lifetime.abort(new Error("BTW side conversation closed"));
		side.request?.abort(new Error("BTW side conversation closed"));
		side.request = undefined;
		side.options.setStatus(undefined);
		side.surface?.close();
	}

	setParentStatus(status: "working" | "idle"): void {
		const side = this.#side;
		if (side === undefined) return;
		side.parentStatus = status;
		side.surface?.panel.setParentStatus(status);
	}

	#submit(side: OpenSide, rawQuestion: string): void {
		if (this.#side !== side || side.lifetime.signal.aborted) return;
		const question = rawQuestion.trim();
		if (question.length === 0) return;
		if (side.request !== undefined) {
			side.options.notify("The side conversation is still answering.", "warning");
			return;
		}
		const request = new AbortController();
		side.request = request;
		side.surface?.panel.startTurn(question);

		void side.options
			.runQuestion({
				question,
				signal: request.signal,
				onTextDelta: (delta) => {
					if (this.#side === side && side.request === request) side.surface?.panel.appendText(delta);
				},
			})
			.then((answer) => {
				if (this.#side !== side || side.request !== request || request.signal.aborted) return;
				const entry: BtwHistoryEntry = { question, answer, timestamp: Date.now() };
				side.options.persist(entry);
				side.surface?.panel.completeTurn(entry);
			})
			.catch((error: unknown) => {
				if (this.#side !== side || side.request !== request) return;
				if (request.signal.aborted) {
					side.surface?.panel.abortTurn();
					return;
				}
				side.surface?.panel.failTurn(errorMessage(error, "Side query failed."));
			})
			.finally(() => {
				if (this.#side === side && side.request === request) side.request = undefined;
			});
	}
}
