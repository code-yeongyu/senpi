/**
 * "This server needs OAuth" classification, shared by the connect path
 * (`connection.ts`) and the tool-call health path (`health.ts`).
 *
 * Lives in its own module so neither of those files has to import the MCP SDK
 * for the `UnauthorizedError` identity check; `sdk.lazy.ts` owns that identity
 * and answers synchronously from the module the auth/HTTP paths already loaded.
 */
import { OAuthFlowError } from "./auth/oauth-errors.ts";
import { isMcpSdkUnauthorizedError } from "./sdk.lazy.ts";

const MAX_CAUSE_DEPTH = 5;

export function isMcpNeedsAuthError(error: unknown, depth = 0): boolean {
	if (isMcpSdkUnauthorizedError(error)) return true;
	if (error instanceof OAuthFlowError) return error.terminal;
	// connectMcpTransport wraps the SDK error in a ConnectError; unwrap the cause.
	if (depth < MAX_CAUSE_DEPTH && error !== null && typeof error === "object" && "cause" in error) {
		return isMcpNeedsAuthError(error.cause, depth + 1);
	}
	return false;
}
