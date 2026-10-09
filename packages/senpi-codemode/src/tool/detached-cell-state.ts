import type { EvalDetachedCellState } from "./detached-cell-manager.ts";
import type { EvalToolInput } from "./types.ts";

interface DetachedCellIdentity {
	readonly cellId: string;
	readonly input: EvalToolInput;
	readonly state: EvalDetachedCellState;
	readonly detached?: boolean;
}

export function activeDetachedCellReuseError(cell: DetachedCellIdentity): Error {
	return new Error(
		`Eval cell ${cell.cellId} from a previous call is still ${cell.detached ? "detached" : cell.state} in the ${cell.input.language} kernel. Use eval({ action: "peek", cell_id: "${cell.cellId}" }) to read it or eval({ action: "stop", cell_id: "${cell.cellId}" }) to end it before its id can be reused.`,
	);
}

export function allowsDetachedCellTransition(from: EvalDetachedCellState, to: EvalDetachedCellState): boolean {
	if (from === "queued") return to === "running" || to === "failed" || to === "cancelled";
	if (from === "running") return to === "completed" || to === "failed" || to === "cancelled";
	return false;
}

export function detachedCellIsActive(state: EvalDetachedCellState): boolean {
	return state === "queued" || state === "running" || state === "detached";
}
