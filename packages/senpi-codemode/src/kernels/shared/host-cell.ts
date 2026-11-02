import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { HostCellExecutor } from "../../tool/types.ts";

type HostCellOutcome = Awaited<ReturnType<HostCellExecutor>>;
type HostResult = Extract<KernelToHostMessage, { type: "result" }>;

export interface HostCellRun {
	readonly cellId: string;
	readonly abort: AbortController;
	readonly done: Promise<HostResult>;
}

/**
 * Runs a host entry (a cell the host executes, such as an install) for one queue slot: output after the outcome or after
 * an abort belongs to no cell, a synchronous throw stays in this cell, and `settle` receives the cell's result.
 * `settleAfterAbort` says whether an aborted entry still settles here or whoever aborted it settles the cell.
 */
export function runHostCell(
	cellId: string,
	host: HostCellExecutor,
	io: {
		readonly emit: (message: KernelToHostMessage) => void;
		readonly settle: (result: HostResult) => void;
		readonly durationMs: () => number;
		readonly settleAfterAbort: boolean;
	},
): HostCellRun {
	const abort = new AbortController();
	let finished = false;
	const emit = (message: KernelToHostMessage): void => {
		if (!finished && !abort.signal.aborted) io.emit(message);
	};
	const done = new Promise<HostCellOutcome>((resolve) => resolve(host({ signal: abort.signal, emit }))).then(
		(outcome): HostResult =>
			outcome.ok
				? {
						type: "result",
						cellId,
						ok: true,
						durationMs: io.durationMs(),
						...(outcome.valueRepr === undefined ? {} : { valueRepr: outcome.valueRepr }),
					}
				: { type: "result", cellId, ok: false, error: outcome.error, durationMs: 0 },
		(error: unknown): HostResult => ({
			type: "result",
			cellId,
			ok: false,
			error: { message: error instanceof Error ? error.message : String(error) },
			durationMs: 0,
		}),
	);
	void done.then((result) => {
		finished = true;
		if (io.settleAfterAbort || !abort.signal.aborted) io.settle(result);
	});
	return { cellId, abort, done };
}
