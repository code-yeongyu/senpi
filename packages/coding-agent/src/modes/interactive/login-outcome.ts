/**
 * Classifies how a failed `/login` or API-key dialog ends so interactive mode
 * renders a cancellation as a neutral status line and only a genuine
 * provider/network/OAuth failure as an error.
 */

import { CredentialSynchronizationError } from "../../core/model-runtime.ts";

export type LoginMethod = "oauth" | "api_key";

export type LoginFailureNotice = { level: "status" | "error"; message: string };

export const LOGIN_CANCELLED_NOTICE = "Login cancelled";

/**
 * A login ends by cancellation when its abort reason is an abort: the dialog's
 * `AbortController.abort()` with no reason (a DOMException named `AbortError`
 * whose message is "This operation was aborted"), the `AbortError` fabricated by
 * `raceWithAbortSignal`, an explicit `"Login cancelled"`, or no reason at all.
 */
export function isLoginCancellation(error: unknown): boolean {
	if (error === undefined || error === null) return true;
	if (typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return true;
	return errorMessage(error) === LOGIN_CANCELLED_NOTICE;
}

export function describeLoginFailure(error: unknown, providerName: string, method: LoginMethod): LoginFailureNotice {
	if (isLoginCancellation(error)) return { level: "status", message: LOGIN_CANCELLED_NOTICE };
	const message = errorMessage(error);
	if (error instanceof CredentialSynchronizationError) {
		const done = method === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;
		return { level: "error", message: `${done}, but local model state could not be synchronized: ${message}` };
	}
	const failed =
		method === "oauth" ? `Failed to login to ${providerName}` : `Failed to save API key for ${providerName}`;
	return { level: "error", message: `${failed}: ${message}` };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
