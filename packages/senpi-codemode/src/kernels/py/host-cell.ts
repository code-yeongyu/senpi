import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { HostCellExecutor } from "../../tool/types.ts";
import { runHostCell as runSharedHostCell } from "../shared/host-cell.ts";
import type { PendingRun, ResultMessage } from "./kernel-contract.ts";

export function runHostCell(
	pending: PendingRun,
	host: HostCellExecutor,
	io: { readonly emit: (message: KernelToHostMessage) => void; readonly settle: (result: ResultMessage) => void },
): void {
	const run = runSharedHostCell(pending.input.cellId, host, {
		emit: io.emit,
		settle: io.settle,
		durationMs: () => 0,
		settleAfterAbort: false,
	});
	pending.hostAbort = run.abort;
	pending.hostDone = run.done;
}
