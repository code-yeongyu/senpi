/** A painted animation requests its next frame once; an unpainted component never keeps ticking. */
export class AnimationFrame {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private readonly requestRender: () => void;
	private readonly intervalMs: number;

	constructor(requestRender: () => void, intervalMs = 80) {
		this.requestRender = requestRender;
		this.intervalMs = intervalMs;
	}

	schedule(): void {
		if (this.timer || this.stopped) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.requestRender();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	cancel(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	dispose(): void {
		this.cancel();
		this.stopped = true;
	}
}
