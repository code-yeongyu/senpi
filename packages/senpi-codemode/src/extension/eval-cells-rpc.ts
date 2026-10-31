import { EvalCellNotFoundError, type EvalDetachedCellManager } from "../tool/detached-cell-manager.ts";
import { listEvalCells } from "../tool/detached-eval-result.ts";

const DEFAULT_TAIL_BYTES = 8 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;

class InvalidEvalCellRequestError extends Error {
	readonly code = "invalid_eval_cell_request";

	constructor(message: string) {
		super(message);
		this.name = "InvalidEvalCellRequestError";
	}
}

/** Extension RPC handlers never invoke a model tool or write a session entry. */
export function registerEvalCellsRpc(
	rpc: { handle?(name: string, handler: (data: unknown) => unknown | Promise<unknown>): void } | undefined,
	getCells: () => EvalDetachedCellManager | undefined,
): void {
	rpc?.handle?.("eval_cells.list", () => {
		const cells = getCells();
		return cells === undefined ? [] : listEvalCells(cells);
	});
	for (const action of ["peek", "stop"] as const) {
		rpc?.handle?.(`eval_cells.${action}`, async (data) => {
			if (
				typeof data !== "object" ||
				data === null ||
				!("cellId" in data) ||
				typeof data.cellId !== "string" ||
				data.cellId.trim().length === 0
			) {
				throw new InvalidEvalCellRequestError("cellId must be a non-empty string");
			}
			const tailBytes = action === "peek" && "tailBytes" in data ? data.tailBytes : DEFAULT_TAIL_BYTES;
			if (typeof tailBytes !== "number" || !Number.isSafeInteger(tailBytes) || tailBytes < 0) {
				throw new InvalidEvalCellRequestError("tailBytes must be a non-negative safe integer");
			}
			const cells = getCells();
			if (cells === undefined) throw new EvalCellNotFoundError(data.cellId);
			const snapshot = action === "stop" ? await cells.stop(data.cellId) : cells.peek(data.cellId);
			const bytes = Buffer.from(snapshot.outputTail, "utf8");
			let start = Math.max(0, bytes.length - Math.min(tailBytes, MAX_TAIL_BYTES));
			// Drop a partial leading UTF-8 character instead of expanding it into a replacement character.
			while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
			return {
				cellId: snapshot.cellId,
				language: snapshot.language,
				state: snapshot.state,
				startedAtMs: snapshot.startedAtMs,
				...(snapshot.result.details.summary ? { summary: snapshot.result.details.summary } : {}),
				...(snapshot.queuedBehind === undefined ? {} : { queuedBehind: snapshot.queuedBehind }),
				outputTail: bytes.subarray(start).toString("utf8"),
				...(snapshot.stateRetained === undefined ? {} : { stateRetained: snapshot.stateRetained }),
				...(snapshot.interruptNote === undefined ? {} : { interruptNote: snapshot.interruptNote }),
				...(snapshot.hardLimitSeconds === undefined ? {} : { hardLimitSeconds: snapshot.hardLimitSeconds }),
				...(snapshot.runBudgetSeconds === undefined ? {} : { runBudgetSeconds: snapshot.runBudgetSeconds }),
			};
		});
	}
}
