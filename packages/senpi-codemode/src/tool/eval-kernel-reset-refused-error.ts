import type { EvalLanguage } from "./types.ts";

export class EvalKernelResetRefusedError extends Error {
	readonly name = "EvalKernelResetRefusedError";
	readonly code = "eval_kernel_busy_reset_refused";

	constructor(language: EvalLanguage, liveCellIds: readonly string[]) {
		super(
			`eval_kernel_busy_reset_refused: Cannot reset the ${language} kernel: live cells ${liveCellIds.join(", ")}. Stop them with eval({ action: "stop", cell_id }) or wait for their notifications, then reset.`,
		);
	}
}
