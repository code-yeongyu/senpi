import type { TUI } from "@earendil-works/pi-tui";

/** Absolute question countdown. An external deadline is display-only; its owner settles the request. */
export class AskUserCountdown {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		timeoutMs: number,
		tui: TUI | undefined,
		onTick: (remainingMs: number) => void,
		onExpire: () => void,
		getDeadlineAtMs?: () => number,
	) {
		const deadline = Date.now() + timeoutMs;
		const tick = () => {
			const remaining = Math.max(0, (getDeadlineAtMs?.() ?? deadline) - Date.now());
			onTick(remaining);
			tui?.requestRender();
			if (remaining === 0 && !getDeadlineAtMs) {
				this.dispose();
				onExpire();
			}
		};
		this.timer = setInterval(tick, 1_000);
		this.timer.unref();
		tick();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
