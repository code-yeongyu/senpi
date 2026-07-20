import { parseStreamingJson } from "@earendil-works/pi-ai";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { DEFAULT_SMOOTH_FPS, MAX_SMOOTH_FPS, MIN_SMOOTH_FPS, nextStep } from "./streaming-reveal.ts";

export const MIN_TOOL_ARGS_PARSE_DELTA = 64;

type ToolArgsRevealComponent = Pick<ToolExecutionComponent, "updateArgs">;

type ToolArgsRevealState = {
	component: ToolArgsRevealComponent;
	target: string;
	revealed: number;
	rendered: number;
	lastTickAt: number;
};

export type ToolArgsRevealControllerOptions = {
	readonly getSmoothStreaming: () => boolean;
	readonly getSmoothStreamingFps: () => number;
	readonly requestRender: () => void;
};

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

function advancePastSurrogateBoundary(text: string, end: number): number {
	if (end <= 0 || end >= text.length) return end;
	return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end + 1 : end;
}

export class ToolArgsRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getSmoothStreamingFps: () => number;
	readonly #requestRender: () => void;
	readonly #states = new Map<string, ToolArgsRevealState>();
	#timer: NodeJS.Timeout | undefined;
	#timerFps: number | undefined;

	constructor(options: ToolArgsRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getSmoothStreamingFps = options.getSmoothStreamingFps;
		this.#requestRender = options.requestRender;
	}

	update(id: string, component: ToolArgsRevealComponent, partialJson: string): boolean {
		if (!this.#getSmoothStreaming() || partialJson.length === 0) {
			this.finish(id);
			return false;
		}

		const existing = this.#states.get(id);
		if (existing === undefined || existing.component !== component || !partialJson.startsWith(existing.target)) {
			component.updateArgs(parseStreamingJson(partialJson));
			this.#states.set(id, {
				component,
				target: partialJson,
				revealed: partialJson.length,
				rendered: partialJson.length,
				lastTickAt: performance.now(),
			});
			this.#syncTimer();
			return true;
		}

		const wasCaughtUp = existing.revealed >= existing.target.length;
		existing.target = partialJson;
		if (wasCaughtUp && existing.revealed < partialJson.length) {
			existing.lastTickAt = performance.now();
		}
		this.#syncTimer();
		return true;
	}

	flush(id: string, exactArgs: unknown): boolean {
		const state = this.#states.get(id);
		if (state === undefined) return false;
		state.component.updateArgs(exactArgs);
		this.#states.delete(id);
		this.#syncTimer();
		return true;
	}

	flushAll(): void {
		for (const state of this.#states.values()) {
			state.component.updateArgs(parseStreamingJson(state.target));
		}
		this.#states.clear();
		this.#stopTimer();
	}

	finish(id: string): void {
		if (!this.#states.delete(id)) return;
		this.#syncTimer();
	}

	refresh(): void {
		if (!this.#getSmoothStreaming()) {
			this.flushAll();
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

	#syncTimer(): void {
		if (!this.#hasBacklog()) {
			this.#stopTimer();
			return;
		}
		this.#startTimer(false);
	}

	#hasBacklog(): boolean {
		for (const state of this.#states.values()) {
			if (state.revealed < state.target.length) return true;
		}
		return false;
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
			if (state.revealed < state.target.length) state.lastTickAt = now;
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
			this.flushAll();
			this.#requestRender();
			return;
		}

		const now = performance.now();
		let rendered = false;
		for (const state of this.#states.values()) {
			const backlog = state.target.length - state.revealed;
			if (backlog <= 0) continue;
			const step = nextStep(backlog, now - state.lastTickAt);
			state.revealed = advancePastSurrogateBoundary(
				state.target,
				Math.min(state.target.length, state.revealed + step),
			);
			state.lastTickAt = now;
			if (state.revealed - state.rendered < MIN_TOOL_ARGS_PARSE_DELTA) continue;
			state.component.updateArgs(parseStreamingJson(state.target.slice(0, state.revealed)));
			state.rendered = state.revealed;
			rendered = true;
		}
		if (rendered) this.#requestRender();
		this.#syncTimer();
	}
}
