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
	private consecutiveGone = false;
	private goneWait: { readonly token: string; readonly until: number } | undefined;
	private readonly restartedTokens = new Set<string>();

	private rememberRestart(token: string): void {
		this.restartedTokens.add(token);
		if (this.restartedTokens.size > 64) {
			const oldest = this.restartedTokens.values().next();
			if (!oldest.done) this.restartedTokens.delete(oldest.value);
		}
	}

	observe(
		input: unknown,
		now: number,
		context?: { readonly token: string; readonly reason: string },
	): RecoveryRepairAction {
		if (!isRecoveryRepairAdvice(input)) throw new RecoveryRepairAdviceError();
		if (
			input.state === "repair_needed" &&
			context &&
			(context.reason === "unknown_token" || context.reason === "released")
		) {
			const delay = Math.max(100, input.retryAfterMs);
			this.blocked = undefined;
			if (this.restartedTokens.has(context.token)) return { action: "wait", retryAfterMs: delay };
			if (!this.consecutiveGone) {
				this.consecutiveGone = true;
				this.rememberRestart(context.token);
				return { action: "restart_from_catalog" };
			}
			if (this.goneWait?.token !== context.token) this.goneWait = { token: context.token, until: now + delay };
			if (now >= this.goneWait.until) {
				this.rememberRestart(context.token);
				this.goneWait = undefined;
				return { action: "restart_from_catalog" };
			}
			return { action: "wait", retryAfterMs: Math.max(100, this.goneWait.until - now) };
		}
		if (input.state === "ok") {
			this.consecutiveGone = false;
			this.goneWait = undefined;
		}
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
