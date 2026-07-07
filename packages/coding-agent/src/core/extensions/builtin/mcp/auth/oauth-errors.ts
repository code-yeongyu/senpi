import { AuthError, type McpErrorOptions } from "../errors.ts";

// Distinguishes terminal auth failures (drop credentials, require re-auth) from
// transient ones (retry, keep credentials) and specific refusals.
export type OAuthFailureKind =
	| "s256_unsupported"
	| "needs_auth"
	| "invalid_grant"
	| "transient"
	| "state_mismatch"
	| "expired_code"
	| "no_verifier"
	| "headless"
	| "missing_env";

export class OAuthFlowError extends AuthError {
	readonly oauthKind: OAuthFailureKind;
	readonly terminal: boolean;

	constructor(oauthKind: OAuthFailureKind, message: string, options: McpErrorOptions = {}) {
		super(message, options);
		this.name = "OAuthFlowError";
		this.oauthKind = oauthKind;
		this.terminal = TERMINAL_KINDS.has(oauthKind);
	}
}

const TERMINAL_KINDS = new Set<OAuthFailureKind>([
	"s256_unsupported",
	"needs_auth",
	"invalid_grant",
	"state_mismatch",
	"expired_code",
	"no_verifier",
	"headless",
	"missing_env",
]);

const TERMINAL_OAUTH_CODES = new Set(["invalid_grant", "invalid_token", "invalid_client", "unauthorized_client"]);
const TRANSIENT_OAUTH_CODES = new Set(["temporarily_unavailable", "server_error", "slow_down"]);

export function isInvalidGrant(error: unknown): boolean {
	const code = oauthErrorCode(error);
	if (code !== undefined) return TERMINAL_OAUTH_CODES.has(code);
	const text = errorText(error).toLowerCase();
	return text.includes("invalid_grant") || text.includes("invalid_token");
}

export function isTransientTokenError(error: unknown): boolean {
	if (isInvalidGrant(error)) return false;
	const code = oauthErrorCode(error);
	if (code !== undefined && TRANSIENT_OAUTH_CODES.has(code)) return true;
	const text = errorText(error).toLowerCase();
	return /\b(?:500|502|503|504)\b/.test(text) || text.includes("econnrefused") || text.includes("network");
}

// SDK OAuth errors expose a machine-readable `errorCode` (RFC 6749 §5.2).
function oauthErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const code = (error as { errorCode?: unknown }).errorCode;
	return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name} ${error.message}`;
	return String(error);
}
