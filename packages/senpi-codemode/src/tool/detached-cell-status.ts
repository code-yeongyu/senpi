import { SENPI_CODEMODE_WAKE_SOURCE, type WakeSourceState } from "../extension/wake-source-state.ts";
import type { EvalDetachedCellStatusEntry } from "./detached-cell-manager.ts";

export interface LiveDetachedCell {
	readonly cellId: string;
	readonly startedAtMs: number;
	readonly input: { readonly language: EvalDetachedCellStatusEntry["language"]; readonly summary?: string };
}

export function detachedStatusEntries(liveCells: readonly LiveDetachedCell[]): EvalDetachedCellStatusEntry[] {
	return liveCells.map((cell) => ({
		cellId: cell.cellId,
		language: cell.input.language,
		startedAtMs: cell.startedAtMs,
		...(cell.input.summary === undefined ? {} : { summary: cell.input.summary }),
	}));
}

export function detachedWakeSourceState(liveCells: readonly LiveDetachedCell[]): WakeSourceState {
	return {
		source: SENPI_CODEMODE_WAKE_SOURCE,
		activeCount: liveCells.length,
		items: liveCells.map((cell) => ({
			id: cell.cellId,
			description:
				cell.input.summary === undefined || cell.input.summary.length === 0 ? cell.cellId : cell.input.summary,
			startedAtMs: cell.startedAtMs,
		})),
	};
}
