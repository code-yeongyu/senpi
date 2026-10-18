import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\r\u001b[2K";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_LABEL = "Loading";
const DEFAULT_GRACE_MS = 120;
const DEFAULT_INTERVAL_MS = 80;

export interface StartupLoadingIndicatorOptions {
	readonly writer: (chunk: string) => void;
	readonly isTTY: boolean;
	readonly label?: string;
	readonly graceMs?: number;
	readonly intervalMs?: number;
	readonly frames?: readonly string[];
}

export interface StartupLoadingIndicator {
	start(): void;
	setPhase(phase: string | undefined): void;
	pause(): void;
	resume(): void;
	stop(): void;
	readonly running: boolean;
}

/**
 * Single-line ANSI loading indicator for the pre-TUI startup window, borrowed
 * from codex's UI-first startup design (codex-rs/tui keeps a dim placeholder
 * header until the session is configured). The first frame is written in
 * start() itself: the work it covers is synchronous module loading, which
 * starves every timer until it is done, so a timer-driven first frame lands
 * only after that work (measured: 2.27s to the first byte on a real pty). The
 * grace delay now gates the animation only; stop() must run before any other
 * stdout writer (TUI, prompts, help) takes over the terminal.
 */
class AnsiStartupLoadingIndicator implements StartupLoadingIndicator {
	private readonly writer: (chunk: string) => void;
	private readonly isTTY: boolean;
	private readonly label: string;
	private readonly graceMs: number;
	private readonly intervalMs: number;
	private readonly frames: readonly string[];
	private phase: string | undefined = undefined;
	private frameIndex = 0;
	private drawn = false;
	private graceElapsed = false;
	private started = false;
	private paused = false;
	private stopped = false;
	private graceTimer: NodeJS.Timeout | undefined = undefined;
	private frameTimer: NodeJS.Timeout | undefined = undefined;
	private exitListener: (() => void) | undefined = undefined;

	constructor(options: StartupLoadingIndicatorOptions) {
		this.writer = options.writer;
		this.isTTY = options.isTTY;
		this.label = options.label ?? DEFAULT_LABEL;
		this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.frames = options.frames && options.frames.length > 0 ? options.frames : DEFAULT_FRAMES;
	}

	get running(): boolean {
		return this.started && !this.stopped;
	}

	start(): void {
		if (!this.isTTY || this.started || this.stopped) return;
		this.started = true;
		this.exitListener = () => {
			if (this.drawn) this.writer(CLEAR_LINE + SHOW_CURSOR);
		};
		process.on("exit", this.exitListener);
		this.draw(true);
		this.startGraceTimer();
	}

	setPhase(phase: string | undefined): void {
		this.phase = phase;
		if (this.drawn && !this.paused && !this.stopped) {
			this.draw(false);
		}
	}

	pause(): void {
		if (!this.started || this.stopped || this.paused) return;
		this.paused = true;
		this.clearTimers();
		this.eraseLine();
	}

	resume(): void {
		if (!this.started || this.stopped || !this.paused) return;
		this.paused = false;
		if (this.graceElapsed) {
			this.beginAnimation();
		} else {
			this.draw(true);
			this.startGraceTimer();
		}
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.clearTimers();
		this.eraseLine();
		if (this.exitListener) {
			process.removeListener("exit", this.exitListener);
			this.exitListener = undefined;
		}
	}

	private startGraceTimer(): void {
		this.graceTimer = setTimeout(() => {
			this.graceElapsed = true;
			this.beginAnimation();
		}, this.graceMs);
	}

	private beginAnimation(): void {
		if (!this.drawn) this.draw(true);
		this.frameTimer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.draw(false);
		}, this.intervalMs);
	}

	private draw(hideCursor: boolean): void {
		const frame = this.frames[this.frameIndex] ?? "";
		const phaseSuffix = this.phase ? ` ${this.phase}` : "";
		const line = `${DIM}${frame} ${this.label}…${phaseSuffix}${RESET}`;
		this.writer(`${hideCursor ? HIDE_CURSOR : ""}${CLEAR_LINE}${line}`);
		this.drawn = true;
	}

	private eraseLine(): void {
		if (!this.drawn) return;
		this.writer(CLEAR_LINE + SHOW_CURSOR);
		this.drawn = false;
	}

	private clearTimers(): void {
		if (this.graceTimer) {
			clearTimeout(this.graceTimer);
			this.graceTimer = undefined;
		}
		if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = undefined;
		}
	}
}

export function createStartupLoadingIndicator(options: StartupLoadingIndicatorOptions): StartupLoadingIndicator {
	return new AnsiStartupLoadingIndicator(options);
}

export function shouldShowStartupLoadingIndicator(input: {
	readonly appMode: AppMode;
	readonly stdoutIsTTY: boolean;
	readonly helpRequested: boolean;
}): boolean {
	return input.appMode === "interactive" && input.stdoutIsTTY && !input.helpRequested;
}

/**
 * Project-trust prompts open their own startup TUI mid-load; pausing the
 * indicator around each prompt keeps the two from fighting over the terminal.
 */
export function pauseIndicatorDuringPrompts(
	context: ProjectTrustContext,
	indicator: Pick<StartupLoadingIndicator, "pause" | "resume">,
): ProjectTrustContext {
	const wrapPrompt =
		<Args extends readonly unknown[], Result>(
			prompt: (...args: Args) => Promise<Result>,
		): ((...args: Args) => Promise<Result>) =>
		async (...args: Args): Promise<Result> => {
			indicator.pause();
			try {
				return await prompt(...args);
			} finally {
				indicator.resume();
			}
		};
	return {
		...context,
		ui: {
			select: wrapPrompt(context.ui.select),
			confirm: wrapPrompt(context.ui.confirm),
			input: wrapPrompt(context.ui.input),
			notify: context.ui.notify,
		},
	};
}
