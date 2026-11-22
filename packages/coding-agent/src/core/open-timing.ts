import { envValue } from "./brand.ts";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-phase timing of a session open (senpi#5707), for naming the await that holds a slow open.
 * Enable with SENPI_OPEN_TIMING=1. Off, every call returns before reading a clock or touching
 * stderr. On, each mark is one stderr line, written the moment its phase ends:
 *
 *   senpi open-timing <epoch ms> <scope> <phase> +<ms since the scope's previous mark>
 *
 * Lines carry the wall clock so a host's lines and its session worker's lines (another isolate,
 * the same stderr) can be merged in order, and a scope so concurrent opens stay apart.
 */
const ENABLED = envValue("OPEN_TIMING") === "1";

export interface OpenTimer {
	mark(phase: string): void;
}

const DISABLED: OpenTimer = { mark: () => {} };
const speculative = new AsyncLocalStorage<boolean>();

/** Speculative builds have no caller to charge; drop their timing rather than report a misleading open. */
export function withoutOpenTiming<T>(build: () => T): T {
	return speculative.run(true, build);
}

export function openTimingEnabled(): boolean {
	return ENABLED;
}

export function startOpenTimer(scope: string): OpenTimer {
	if (!ENABLED || speculative.getStore()) return DISABLED;
	let last = performance.now();
	return {
		mark(phase) {
			const now = performance.now();
			process.stderr.write(
				`senpi open-timing ${Math.round(performance.timeOrigin + now)} ${scope} ${phase} +${Math.round(now - last)}ms\n`,
			);
			last = now;
		},
	};
}
