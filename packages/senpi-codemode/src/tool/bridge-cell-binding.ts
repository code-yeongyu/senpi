import { randomUUID } from "node:crypto";
import type { KernelToolsCapability } from "../kernels/js/kernel-tools-types.ts";
import type { CellToolUpdateSink } from "./nested-tool-output.ts";
import type { EvalKernelManager, EvalLanguage } from "./types.ts";

export interface BridgeCellBinding {
	readonly token: string | undefined;
	/** First thing a settling cell runs: from then on a call carrying the token gets no kernel tools and streams nowhere. */
	readonly release: () => void;
}

/**
 * Subprocess kernels call the host over the bridge, outside this cell's async context. Their calls carry a fresh
 * secret minted for this run and sent only to this cell's kernel, never the model-visible cell id, so code in another
 * kernel cannot name this cell into its tools or its live view. JS calls already run inside this cell's scope (#1754).
 */
export function bindBridgeCell(
	manager: EvalKernelManager,
	language: EvalLanguage,
	kernelTools: KernelToolsCapability | undefined,
	toolUpdates: CellToolUpdateSink,
): BridgeCellBinding {
	if (language === "js") return { token: undefined, release: () => undefined };
	const token = randomUUID();
	const releaseKernelTools = kernelTools === undefined ? undefined : manager.bindCellKernelTools?.(token, kernelTools);
	const releaseToolUpdates = manager.bindCellToolUpdates?.(token, toolUpdates);
	return {
		token,
		release: () => {
			releaseKernelTools?.();
			releaseToolUpdates?.();
		},
	};
}
