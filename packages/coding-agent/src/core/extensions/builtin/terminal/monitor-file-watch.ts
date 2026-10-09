// fs.watch misses events under rename-heavy writers, so file monitors poll. A paused watch
// clears its timer entirely (zero wakeups, zero stat/digest work) and resume() runs one
// immediate check, so a change made during the pause is still detected and fired.
export const FILE_MONITOR_POLL_MS = 250;

export class FileWatchLoop {
	readonly #check: () => void;
	#timer: ReturnType<typeof setInterval> | undefined;
	#stopped = false;

	constructor(check: () => void) {
		this.#check = check;
		this.#start();
	}

	pause(): void {
		if (this.#timer === undefined) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	resume(): void {
		if (this.#stopped || this.#timer !== undefined) return;
		this.#start();
		this.#check();
	}

	stop(): void {
		this.#stopped = true;
		this.pause();
	}

	#start(): void {
		this.#timer = setInterval(this.#check, FILE_MONITOR_POLL_MS);
	}
}
