import type { HostToKernelMessage } from "../../bridge/protocol.ts";
import type { HostCellExecutor } from "../../tool/types.ts";
import { inputAtStart } from "../shared/cell-source-at-start.ts";
import { refusedEntry } from "./host-entries.ts";
import {
	type JavaScriptKernelOptions,
	type JavaScriptRunInput,
	resolveKernelToolNameSource,
} from "./kernel-contract.ts";
import type { LocalModuleLoader } from "./local-module-loader.ts";

export type CellDispatch =
	| { readonly kind: "host"; readonly host: HostCellExecutor }
	| { readonly kind: "worker"; readonly frames: readonly HostToKernelMessage[] };

/**
 * Decides at the cell's turn how it runs: as a host entry (an install, or a turn-time refusal such as an unreadable
 * `%load` file) or in the worker, with the frames the worker needs (the current kernel-tool names, then the cell).
 */
export function dispatchCell(
	queued: JavaScriptRunInput,
	loader: LocalModuleLoader,
	options: Pick<JavaScriptKernelOptions, "hostToolNames" | "foreignLanguageNames">,
): CellDispatch {
	const input = inputAtStart(queued);
	if ("refused" in input) return { kind: "host", host: refusedEntry(input.refused) };
	if (input.host !== undefined) return { kind: "host", host: input.host };
	return {
		kind: "worker",
		frames: [
			{
				type: "kernel-tools-names",
				hostToolNames: resolveKernelToolNameSource(options.hostToolNames),
				foreignLanguageNames: resolveKernelToolNameSource(options.foreignLanguageNames),
			},
			{
				type: "run",
				cellId: input.cellId,
				code: loader.prepareCell(input.code, input.kernelPreludes, input.sourceFile, input.packageRoot?.()),
				timeoutMs: input.timeoutMs,
			},
		],
	};
}
