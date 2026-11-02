import { AsyncLocalStorage } from "node:async_hooks";

// Every continuation a cell creates (awaits, timers, I/O callbacks) runs inside its cell record. Stopping a cell
// releases it: everything it owns is cleared, rejected or closed (`cell-ownership.js` decides what a cell owns), and
// anything its code tries to start afterwards is refused, while the kernel and its variables stay.
const cellRuns = new AsyncLocalStorage();
const releasedInterruptions = new WeakMap();
const MAX_CAUSE_DEPTH = 8;

export function runInCell(cell, run) {
	return cellRuns.run(cell, run);
}

export function currentCell() {
	return cellRuns.getStore();
}

export function releasedCellError() {
	const cell = cellRuns.getStore();
	return cell?.released === true ? cell.interruption : undefined;
}

export function assertCellLive() {
	const error = releasedCellError();
	if (error !== undefined) throw error;
}

export function onCellRelease(close) {
	const cell = cellRuns.getStore();
	return cell === undefined ? () => {} : onReleaseOf(cell, close);
}

export function onReleaseOf(cell, close) {
	cell.onRelease ??= new Set();
	cell.onRelease.add(close);
	return () => cell.onRelease.delete(close);
}

/**
 * Releases the cell: every closer runs even when an earlier one throws, and the failures are returned so the caller
 * can report them; a resource that would not close is a fact the user should see, not something to swallow.
 */
export function releaseCell(cell) {
	cell.released = true;
	releasedInterruptions.set(cell.interruption, cell);
	const failures = [];
	for (const close of cell.onRelease ?? []) {
		try {
			close();
		} catch (error) {
			failures.push(error);
		}
	}
	cell.onRelease?.clear();
	return failures;
}

/**
 * The cell an unhandled rejection came from: a released cell whose interruption is the reason or sits in its `cause`
 * chain, or the cell whose async context the rejection runs in (Node exposes it to the handler; Bun does not).
 */
export function cellOfRejection(reason) {
	let current = reason;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null; depth++) {
		const cell = releasedInterruptions.get(current);
		if (cell !== undefined) return cell;
		current = current.cause;
	}
	return cellRuns.getStore();
}

// An operation already in flight when its cell is released rejects with the interruption at once, so the stopped
// cell's continuation never runs again; a non-promise result is returned as it is.
export function settleWithCell(cell, result) {
	if (result === null || typeof result !== "object" || typeof result.then !== "function") return result;
	return new Promise((resolve, reject) => {
		const forget = onReleaseOf(cell, () => reject(cell.interruption));
		result.then(
			(value) => {
				forget();
				resolve(value);
			},
			(error) => {
				forget();
				reject(error);
			},
		);
	});
}
