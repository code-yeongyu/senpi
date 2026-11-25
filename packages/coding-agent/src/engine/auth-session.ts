import type { AuthCheckReason, AuthCheckStatus } from "../cli/auth-check.ts";
import type { AuthAccountCheckCode } from "../cli/auth-account-check.ts";
import type { AuthStatus } from "./auth.ts";

/** One account as a session sees it: whether it is signed in, and its last connection test as a closed code. */
export interface SessionAuthAccount {
	readonly signed_in: boolean;
	readonly check?: "ok" | AuthAccountCheckCode;
}

/**
 * `engine.auth.check` as a session may be given it (security design 137d6b9879, the owner's option (c)): the
 * provider, status codes from closed sets, and for each account only whether it is signed in. No email, no
 * organisation name, no other text the provider returned; the person and script answer (`AuthStatus`) keeps those.
 */
export interface SessionAuthStatus {
	readonly provider: string;
	readonly status: AuthCheckStatus;
	readonly reason?: AuthCheckReason;
	readonly auth_type?: "api_key" | "oauth";
	readonly accounts: readonly SessionAuthAccount[];
}

export function toSessionAuthStatus(answer: AuthStatus): SessionAuthStatus {
	return {
		provider: answer.provider,
		status: answer.status,
		...(answer.reason === undefined ? {} : { reason: answer.reason }),
		...(answer.authType === undefined ? {} : { auth_type: answer.authType }),
		accounts: answer.accounts.map((account) => ({
			signed_in: account.signedOut !== true && account.signIn !== "needs_sign_in",
			...(account.check === undefined
				? {}
				: { check: account.check.outcome === "ok" ? "ok" : (account.check.code ?? "unrecognized") }),
		})),
	};
}
