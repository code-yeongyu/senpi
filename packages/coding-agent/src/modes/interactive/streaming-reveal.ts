import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BlockUnitCounter, buildDisplayMessage, countVisibleUnits } from "./streaming-reveal-content.ts";
import {
	DEFAULT_SMOOTH_FPS,
	INITIAL_BUFFER_MS,
	MAX_SMOOTH_FPS,
	MIN_SMOOTH_FPS,
	nextStep,
	updateArrivalRate,
} from "./streaming-reveal-pacing.ts";

export * from "./streaming-reveal-content.ts";
export * from "./streaming-reveal-pacing.ts";

type StreamingRevealComponent = Pick<AssistantMessageComponent, "updateContent">;

export type StreamingRevealControllerOptions = {
	readonly getSmoothStreaming: () => boolean;
	readonly getSmoothStreamingFps: () => number;
	readonly getHideThinkingBlock: () => boolean;
	readonly requestRender: () => void;
};

export class StreamingRevealController {
	readonly #getSmoothStreaming: () => boolean;
	readonly #getSmoothStreamingFps: () => number;
	readonly #getHideThinkingBlock: () => boolean;
	readonly #requestRender: () => void;
	readonly #unitCounter = new BlockUnitCounter();
	readonly #countOf = (index: number, text: string): number => this.#unitCounter.count(index, text);
	readonly #sliceOf = (index: number, text: string, units: number): string =>
		this.#unitCounter.slice(index, text, units);
	#target: AssistantMessage | undefined;
	#component: StreamingRevealComponent | undefined;
	#timer: NodeJS.Timeout | undefined;
	#timerFps: number | undefined;
	#revealed = 0;
	#lastTickAt = 0;
	#firstBufferedAt: number | undefined;
	#lastTargetAt: number | undefined;
	#arrivalRate = 90;
	#stepCarry = 0;
	#hideThinkingBlock = false;

	constructor(options: StreamingRevealControllerOptions) {
		this.#getSmoothStreaming = options.getSmoothStreaming;
		this.#getSmoothStreamingFps = options.getSmoothStreamingFps;
		this.#getHideThinkingBlock = options.getHideThinkingBlock;
		this.#requestRender = options.requestRender;
	}

	begin(component: StreamingRevealComponent, message: AssistantMessage): void {
		this.stop();
		this.#component = component;
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		if (this.#visibleUnits(message) > 0) {
			const now = performance.now();
			this.#firstBufferedAt = now;
			this.#lastTargetAt = now;
		}
		this.#applyTarget();
	}

	setTarget(message: AssistantMessage): void {
		const now = performance.now();
		const previousUnits = this.#target ? this.#visibleUnits(this.#target) : 0;
		this.#target = message;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		const total = this.#visibleUnits(message);
		const appended = Math.max(0, total - previousUnits);
		if (appended > 0) {
			if (this.#firstBufferedAt === undefined) this.#firstBufferedAt = now;
			if (this.#lastTargetAt !== undefined && now > this.#lastTargetAt) {
				this.#arrivalRate = updateArrivalRate(this.#arrivalRate, appended, now - this.#lastTargetAt);
			}
			this.#lastTargetAt = now;
		}
		if (this.#component) this.#applyTarget();
	}

	resyncVisibility(): void {
		if (!this.#target || !this.#component) return;
		this.#hideThinkingBlock = this.#getHideThinkingBlock();
		this.#revealed = Math.min(this.#revealed, this.#visibleUnits(this.#target));
		this.#applyTarget();
	}

	/**
	 * True while this controller is the pacing writer for the given head message:
	 * smooth streaming is on, the head carries no toolCall block (those dump in
	 * full), and a component is still bound (before stop()). While true, callers
	 * must not overwrite the component's content, or the next reveal tick
	 * repaints a shorter prefix after their full write (dual-write flicker).
	 */
	isPacingHead(message: AssistantMessage): boolean {
		if (!this.#target || !this.#component) return false;
		return this.#getSmoothStreaming() && !message.content.some((block) => block.type === "toolCall");
	}

	stop(): void {
		this.#stopTimer();
		this.#target = undefined;
		this.#component = undefined;
		this.#revealed = 0;
		this.#lastTickAt = 0;
		this.#unitCounter.reset();
		this.#firstBufferedAt = undefined;
		this.#lastTargetAt = undefined;
		this.#arrivalRate = 90;
		this.#stepCarry = 0;
	}

	#applyTarget(): void {
		const target = this.#target;
		const component = this.#component;
		if (!target || !component) return;
		const total = this.#visibleUnits(target);
		if (!this.#getSmoothStreaming() || target.content.some((block) => block.type === "toolCall")) {
			this.#revealed = total;
			this.#stepCarry = 0;
			this.#stopTimer();
			component.updateContent(target);
			return;
		}
		this.#revealed = Math.min(this.#revealed, total);
		this.#renderCurrent();
		this.#syncTimer(total);
	}

	#visibleUnits(message: AssistantMessage): number {
		return countVisibleUnits(message, this.#hideThinkingBlock, this.#countOf);
	}

	#renderCurrent(): void {
		if (!this.#target || !this.#component) return;
		this.#component.updateContent(
			buildDisplayMessage(this.#target, this.#revealed, this.#hideThinkingBlock, this.#countOf, this.#sliceOf),
		);
	}

	#syncTimer(total: number): void {
		if (this.#revealed >= total) {
			this.#stepCarry = 0;
			this.#stopTimer();
			return;
		}
		this.#startTimer();
	}

	#startTimer(): void {
		const configuredFps = this.#getSmoothStreamingFps();
		const fps = Number.isFinite(configuredFps)
			? Math.min(MAX_SMOOTH_FPS, Math.max(MIN_SMOOTH_FPS, configuredFps))
			: DEFAULT_SMOOTH_FPS;
		if (this.#timer && this.#timerFps === fps) return;
		this.#stopTimer();
		this.#lastTickAt = performance.now();
		const timer = setInterval(() => this.#tick(), 1000 / fps);
		timer.unref();
		this.#timer = timer;
		this.#timerFps = fps;
	}

	#stopTimer(): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#timerFps = undefined;
	}

	#tick(): void {
		const target = this.#target;
		if (!target || !this.#component) {
			this.stop();
			return;
		}
		const total = this.#visibleUnits(target);
		if (this.#revealed >= total) {
			this.#stepCarry = 0;
			this.#stopTimer();
			return;
		}
		const now = performance.now();
		const dt = now - this.#lastTickAt;
		this.#lastTickAt = now;
		if (this.#firstBufferedAt !== undefined && now - this.#firstBufferedAt < INITIAL_BUFFER_MS) return;
		this.#stepCarry += nextStep(total - this.#revealed, dt, this.#arrivalRate);
		const wholeStep = Math.floor(this.#stepCarry);
		if (wholeStep <= 0) return;
		this.#stepCarry -= wholeStep;
		this.#revealed = Math.min(total, this.#revealed + wholeStep);
		this.#renderCurrent();
		this.#requestRender();
		if (this.#revealed >= total) {
			this.#stepCarry = 0;
			this.#stopTimer();
		}
	}
}
