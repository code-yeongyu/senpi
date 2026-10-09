import { classifySdkError } from "./errors.ts";

const TRANSIENT_REFRESH_FAILURE = /\bstatus=5\d\d\b|\bTimeoutError\b/;

/** Throttling, server errors and timeouts on the token endpoint are not a verdict on the grant. */
export function refreshFailure(error: unknown): Error {
	const detail = error instanceof Error ? error.message : String(error);
	const classification = classifySdkError(detail);
	if (classification.kind === "rate_limit" || classification.kind === "overloaded") return new Error(detail);
	if ((classification.kind === "other" && classification.retryable) || TRANSIENT_REFRESH_FAILURE.test(detail)) {
		return new Error(`server_error: ${detail}`);
	}
	return new Error(`authentication_failed: ${detail}`);
}

export function isGrantRejected(error: unknown): boolean {
	return refreshFailure(error).message.startsWith("authentication_failed:");
}
