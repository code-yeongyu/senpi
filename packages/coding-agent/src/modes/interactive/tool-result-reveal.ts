import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import type { ToolExecutionResult } from "./components/tool-execution-types.ts";
import { BlockUnitCounter, DEFAULT_SMOOTH_FPS, MAX_SMOOTH_FPS, MIN_SMOOTH_FPS, nextStep } from "./streaming-reveal.ts";

type ToolResultRevealComponent = Pick<ToolExecutionComponent, "updateResult">;

type ToolResultRevealState = {
	component: ToolResultRevealComponent;
	target: ToolExecutionResult;
	text: string;
	revealed: number;
	lastTickAt: number;
	unitCounter: BlockUnitCounter;
};

export type ToolResultRevealControllerOptions = {
	readonly getSmoothStreaming: () => boolean;
	readonly getSmoothStreamingFps: () => number;
	readonly requestRender: () => void;
};

function firstText(result: ToolExecutionResult): string | undefined {
	const block = result.content[0];
	return block?.type === "text" ? block.text : undefined;
}

function displayResult(state: ToolResultRevealState, revealed = state.revealed): ToolExecutionResult {
	const first = state.target.content[0];
	if (first?.type !== "text") throw new Error("Expected a text tool result");
	return {
		content: [{ ...first, text: state.unitCounter.slice(0, state.text, revealed) }, ...state.target.content.slice(1)],
		details: state.target.details,
		isError: false,
	};
}

export class ToolResultRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getSmoothStreamingFps: () => number;
	readonly #requestRender: () => void;
	readonly #states = new Map<string, ToolResultRevealState>();
	#timer: NodeJS.Timeout | undefined;
	#timerFps: number | undefined;

	constructor(options: ToolResultRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getSmoothStreamingFps = options.getSmoothStreamingFps;
		this.#requestRender = options.requestRender;
	}

	update(id: string, component: ToolResultRevealComponent, partialResult: ToolExecutionResult): boolean {
		const text = firstText(partialResult);
		if (!this.#getSmoothStreaming() || text === undefined) {
			this.#discard(id);
			return false;
		}

		const existing = this.#states.get(id);
		if (existing === undefined || existing.component !== component || !text.startsWith(existing.text)) {
			const state: ToolResultRevealState = {
				component,
				target: partialResult,
				text,
				revealed: 0,
				lastTickAt: performance.now(),
				unitCounter: new BlockUnitCounter(),
			};
			state.revealed = state.unitCounter.count(0, text);
			component.updateResult(displayResult(state), true);
			this.#states.set(id, state);
			this.#syncTimer();
			return true;
		}

		const wasCaughtUp = existing.revealed >= existing.unitCounter.count(0, existing.text);
		existing.target = partialResult;
		existing.text = text;
		const total = existing.unitCounter.count(0, text);
		if (wasCaughtUp && existing.revealed < total) existing.lastTickAt = performance.now();
		this.#syncTimer();
		return true;
	}

	finish(id: string): void {
		const state = this.#states.get(id);
		if (state === undefined) return;
		state.component.updateResult(displayResult(state, state.unitCounter.count(0, state.text)), true);
		this.#states.delete(id);
		this.#syncTimer();
	}

	refresh(): void {
		if (!this.#getSmoothStreaming()) {
			this.#flushAll();
			return;
		}
		if (!this.#hasBacklog()) {
			this.#stopTimer();
			return;
		}
		this.#startTimer(true);
	}

	stop(): void {
		this.#stopTimer();
		this.#states.clear();
	}

	#discard(id: string): void {
		if (!this.#states.delete(id)) return;
		this.#syncTimer();
	}

	#flushAll(): void {
		for (const state of this.#states.values()) {
			state.component.updateResult(displayResult(state, state.unitCounter.count(0, state.text)), true);
		}
		this.#states.clear();
		this.#stopTimer();
	}

	#hasBacklog(): boolean {
		for (const state of this.#states.values()) {
			if (state.revealed < state.unitCounter.count(0, state.text)) return true;
		}
		return false;
	}

	#syncTimer(): void {
		if (!this.#hasBacklog()) {
			this.#stopTimer();
			return;
		}
		this.#startTimer(false);
	}

	#startTimer(restart: boolean): void {
		const configuredFps = this.#getSmoothStreamingFps();
		const fps = Number.isFinite(configuredFps)
			? Math.min(MAX_SMOOTH_FPS, Math.max(MIN_SMOOTH_FPS, configuredFps))
			: DEFAULT_SMOOTH_FPS;
		if (!restart && this.#timer !== undefined && this.#timerFps === fps) return;
		this.#stopTimer();
		const now = performance.now();
		for (const state of this.#states.values()) {
			if (state.revealed < state.unitCounter.count(0, state.text)) state.lastTickAt = now;
		}
		const timer = setInterval(() => this.#tick(), 1000 / fps);
		timer.unref();
		this.#timer = timer;
		this.#timerFps = fps;
	}

	#stopTimer(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#timerFps = undefined;
	}

	#tick(): void {
		if (!this.#getSmoothStreaming()) {
			this.#flushAll();
			this.#requestRender();
			return;
		}

		const now = performance.now();
		let rendered = false;
		for (const state of this.#states.values()) {
			const total = state.unitCounter.count(0, state.text);
			const backlog = total - state.revealed;
			if (backlog <= 0) continue;
			state.revealed = Math.min(total, state.revealed + nextStep(backlog, now - state.lastTickAt));
			state.lastTickAt = now;
			state.component.updateResult(displayResult(state), true);
			rendered = true;
		}
		if (rendered) this.#requestRender();
		this.#syncTimer();
	}
}
