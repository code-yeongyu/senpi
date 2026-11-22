import type { PairedBlock } from "../../scripts/bench-compare.ts";

export const BLOCKS = 3;
export const REPS = 15;

// Deterministic noise: a fixed-seed generator, so every run sees the same "noisy host".
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296 - 0.5;
	};
}

/** Host drift shared by both pair partners (cancels in the ratio) plus independent per-sample noise of `spread`. */
export function noisyBlocks(seed: number, spread: number, ratio = 1): readonly PairedBlock[] {
	const next = generator(seed);
	return Array.from({ length: BLOCKS }, () => {
		const drift = Array.from({ length: REPS }, () => 100 * Math.exp(0.6 * next()));
		const sample = (host: number, scale: number) => {
			const value = host * scale * Math.exp(spread * next());
			return { cpuMs: value, wallMs: value };
		};
		return {
			first: drift.map((host) => sample(host, 1)),
			second: drift.map((host) => sample(host, ratio)),
		};
	});
}
