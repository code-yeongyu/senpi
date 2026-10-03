import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { HostCellExecutor } from "../../tool/types.ts";
import type { PendingRun, ResultMessage } from "./kernel-contract.ts";
import { failedPythonResult } from "./transport.ts";

export function runHostCell(
	pending: PendingRun,
	host: HostCellExecutor,
	io: { readonly emit: (message: KernelToHostMessage) => void; readonly settle: (result: ResultMessage) => void },
): void {
	const abort = new AbortController();
	pending.hostAbort = abort;
	const cellId = pending.input.cellId;
	host({ signal: abort.signal, emit: io.emit }).then(
		(outcome) => {
			io.settle(
				outcome.ok
					? {
							type: "result",
							cellId,
							ok: true,
							durationMs: 0,
							...(outcome.valueRepr === undefined ? {} : { valueRepr: outcome.valueRepr }),
						}
					: { type: "result", cellId, ok: false, error: outcome.error, durationMs: 0 },
			);
		},
		(error: unknown) => {
			if (!abort.signal.aborted)
				io.settle(failedPythonResult(cellId, error instanceof Error ? error.message : String(error)));
		},
	);
}
