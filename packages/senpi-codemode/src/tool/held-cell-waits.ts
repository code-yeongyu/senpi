import type { QueuedWait } from "./queued-wait.ts";
import type { EvalToolDetails } from "./types.ts";

/**
 * What a cell waits on before its kernel runs it, read by the live row at render time. It never enters an event or a
 * tool result, so the transcript stays as it was; only a renderer in the process that runs the cell can see it.
 * Keyed by cell id, which is the eval tool call id.
 */
const heldWaits = new Map<string, QueuedWait>();

export function holdCellWait(cellId: string, wait: QueuedWait): void {
	heldWaits.set(cellId, wait);
}

export function releaseCellWait(cellId: string): void {
	heldWaits.delete(cellId);
}

export function heldCellWait(cellId: string): QueuedWait | undefined {
	return heldWaits.get(cellId);
}

/**
 * A queued cell with nothing ahead of it: the only state a held wait can begin in. Its row repaints itself (no event)
 * so a wait held after the row's last update still shows, and stops at the next update, which changes the state.
 */
export function isFirstInLine(details: EvalToolDetails | undefined): boolean {
	const cell = details?.cells?.[0];
	return cell?.status === "queued" && cell.queuedBehind?.length === 0;
}

/** The details a live row renders: the last update's, with a held wait laid over a queued cell with nothing ahead. */
export function withHeldWait(details: EvalToolDetails, wait: QueuedWait | undefined): EvalToolDetails {
	if (wait === undefined || details.cells === undefined) return details;
	return {
		...details,
		cells: details.cells.map((cell, index) =>
			index === 0 && cell.status === "queued" && cell.queuedBehind?.length === 0
				? { ...cell, waitingFor: wait }
				: cell,
		),
	};
}
