import { isRecoveryRepairAdvice, type RecoveryRepairAdvice } from "@earendil-works/pi-protocol";

export type RecoveryRepairAction =
	| { readonly action: "ready" }
	| { readonly action: "wait"; readonly retryAfterMs: number }
	| { readonly action: "restart_from_catalog" };

export class RecoveryRepairAdviceError extends Error {
	constructor() {
		super("invalid recovery repair advice");
		this.name = "RecoveryRepairAdviceError";
	}
}

/** S14 policy only: S15a drives this from RpcClient. No transport, prompt, current-root read or retry loop lives here. */
export class RecoveryRepairController {
	private blocked: { readonly advice: RecoveryRepairAdvice; readonly until: number } | undefined;

	observe(input: unknown, now: number): RecoveryRepairAction {
		if (!isRecoveryRepairAdvice(input)) throw new RecoveryRepairAdviceError();
		const blocked = this.blocked;
		if (blocked) {
			const before = blocked.advice;
			const changed =
				(input.healthRevision !== null && input.healthRevision !== before.healthRevision) ||
				(input.source !== null &&
					(input.source.sessionEpoch !== before.source?.sessionEpoch ||
						input.source.sequence !== before.source.sequence));
			if (changed && now >= blocked.until) {
				this.blocked = undefined;
				return { action: "restart_from_catalog" };
			}
			return { action: "wait", retryAfterMs: Math.max(100, blocked.until - now) };
		}
		switch (input.state) {
			case "ok":
				return { action: "ready" };
			case "repair_needed":
			case "storage_unavailable":
				this.blocked = { advice: input, until: now + Math.max(100, input.retryAfterMs) };
				return { action: "wait", retryAfterMs: Math.max(100, input.retryAfterMs) };
		}
	}
}
