/** Manual timers for a host under test: a clock that moves only through `advanceTo`, which runs due timers in order. */
export interface ManualTimers {
	now(): number;
	setTimer(callback: () => unknown, ms: number): () => void;
	advanceTo(at: number): Promise<void>;
}

export function createManualTimers(start: number): ManualTimers {
	let time = start;
	let nextId = 1;
	const timers = new Map<number, { due: number; callback: () => unknown }>();
	return {
		now: () => time,
		setTimer: (callback, ms) => {
			const id = nextId++;
			timers.set(id, { due: time + Math.max(0, ms), callback });
			return () => void timers.delete(id);
		},
		async advanceTo(at) {
			for (let step = 0; ; step++) {
				if (step > 10_000) throw new Error("manual timers: more than 10000 timers fired in one advance");
				let next: [number, { due: number; callback: () => unknown }] | undefined;
				for (const entry of timers) {
					if (entry[1].due <= at && (next === undefined || entry[1].due < next[1].due)) next = entry;
				}
				if (next === undefined) break;
				timers.delete(next[0]);
				time = Math.max(time, next[1].due);
				await next[1].callback();
			}
			time = Math.max(time, at);
		},
	};
}
