import { readToolProgress } from "../tool-progress.ts";
import { hasCompletedTodoTasks, TODO_STRIKE_FRAME_INTERVAL_MS, TODO_STRIKE_TOTAL_FRAMES } from "./todo-strike.ts";
import type { ToolExecutionRenderState } from "./tool-execution-types.ts";

const PENDING_RENDER_FRAME_INTERVAL_MS = 80;

/** A card spins while edit-like arguments stream in, or while a partial task or progress result is showing. */
export function toolCardSpins(toolName: string, card: ToolExecutionRenderState): boolean {
	const isStreamingArgs = !card.argsComplete && ["edit", "write", "apply_patch"].includes(toolName);
	const isPartialTask = card.isPartial && toolName === "task" && card.result !== undefined;
	const isPartialProgress =
		card.isPartial && card.result !== undefined && readToolProgress(card.result.details) !== undefined;
	return isStreamingArgs || isPartialTask || isPartialProgress;
}

/** A finished, successful todo card that completed tasks strikes them through once. */
export function toolCardStrikes(toolName: string, card: ToolExecutionRenderState): boolean {
	return (
		toolName === "todo" &&
		card.executionStarted &&
		!card.isPartial &&
		card.result !== undefined &&
		!card.result.isError &&
		hasCompletedTodoTasks(card.result.details)
	);
}

export interface ToolExecutionAnimationHost {
	/** The card's output changed: drop its render cache. */
	invalidate(): void;
	/** Rebuild the card's display and ask the terminal for a frame. */
	redraw(): void;
}

/** A tool card's spinner and todo-strike timers and the frame they advance. */
export class ToolExecutionAnimation {
	readonly #host: ToolExecutionAnimationHost;
	#spinner: NodeJS.Timeout | undefined;
	#strike: NodeJS.Timeout | undefined;
	#frame: number | undefined;

	constructor(host: ToolExecutionAnimationHost) {
		this.#host = host;
	}

	get frame(): number | undefined {
		return this.#frame;
	}

	get running(): boolean {
		return this.#spinner !== undefined || this.#strike !== undefined;
	}

	spin(on: boolean): void {
		if (on) this.#startSpinner();
		else this.#stopSpinner();
	}

	strike(on: boolean): void {
		if (!on) {
			this.#stopStrike();
			return;
		}
		if (this.#strike) return;
		this.#frame = 0;
		this.#strike = setInterval(() => {
			const next = (this.#frame ?? 0) + 1;
			if (next > TODO_STRIKE_TOTAL_FRAMES) {
				this.#stopStrike();
				return;
			}
			this.#frame = next;
			this.#host.invalidate();
			this.#host.redraw();
		}, TODO_STRIKE_FRAME_INTERVAL_MS);
		this.#strike.unref?.();
	}

	stop(): void {
		this.#stopSpinner();
		this.#stopStrike();
	}

	#startSpinner(): void {
		if (this.#spinner) return;
		this.#spinner = setInterval(() => {
			this.#frame = ((this.#frame ?? -1) + 1) % 10;
			this.#host.invalidate();
			this.#host.redraw();
		}, PENDING_RENDER_FRAME_INTERVAL_MS);
		this.#spinner.unref?.();
	}

	#stopSpinner(): void {
		if (!this.#spinner) return;
		clearInterval(this.#spinner);
		this.#spinner = undefined;
		if (!this.#strike) this.#frame = undefined;
		this.#host.invalidate();
	}

	#stopStrike(): void {
		if (this.#strike) {
			clearInterval(this.#strike);
			this.#strike = undefined;
		}
		if (!this.#spinner && this.#frame !== undefined) {
			this.#frame = undefined;
			this.#host.invalidate();
			this.#host.redraw();
		}
	}
}
