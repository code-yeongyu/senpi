import type { ExtensionUIDialogOptions } from "./types.ts";

export type SecretInputUnavailableReason = "headless" | "client_unsupported" | "no_presenter";

/** Fixed guidance only: errors from this boundary never carry the input or an underlying cause. */
export class SecretInputUnavailableError extends Error {
	readonly code = "secret_input_unavailable";
	readonly reason: SecretInputUnavailableReason;
	constructor(reason: SecretInputUnavailableReason) {
		super("This client cannot collect a secret; use the TUI or the host's settings route.");
		this.name = "SecretInputUnavailableError";
		this.reason = reason;
	}
}

export function resolveSecretInputTimeout(opts?: ExtensionUIDialogOptions): number {
	const timeout = opts?.timeout ?? 30 * 60 * 1000;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid secret input timeout");
	return timeout;
}

/** Platform timers clamp delays above 2^31-1; recheck the original deadline rather than renewing it. */
export function armSecretInputDeadline(deadline: number, expire: () => void): () => void {
	let timer: ReturnType<typeof setTimeout>;
	const check = () => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) expire();
		else timer = setTimeout(check, Math.min(remaining, 2 ** 31 - 1));
	};
	timer = setTimeout(check, Math.max(0, Math.min(deadline - Date.now(), 2 ** 31 - 1)));
	return () => clearTimeout(timer);
}

/** A secret is never normalized: unrepresentable single-line input is refused instead. */
export function isSecretInputValue(value: string): boolean {
	return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}
