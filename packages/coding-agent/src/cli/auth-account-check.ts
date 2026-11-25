import type { CredentialAccountCheck, CredentialAccountSummary } from "../core/credential-accounts.ts";

/**
 * The closed set a connection test's failure is told by (security owner ruling on engine.auth.check, senpi#7451):
 * the subscription error kinds, the test's own three, and `unrecognized` for a stored reason outside the set.
 */
export const AUTH_ACCOUNT_CHECK_CODES = [
	"rate_limit",
	"overloaded",
	"auth_error",
	"login_unreadable",
	"billing",
	"org_not_allowed",
	"entitlement",
	"long_context_unavailable",
	"other",
	"timeout",
	"cancelled",
	"no_result",
	"unrecognized",
] as const;
export type AuthAccountCheckCode = (typeof AUTH_ACCOUNT_CHECK_CODES)[number];

/**
 * One account's last connection test as two parts: what the engine says from a closed code (`code`, `message`),
 * and what the provider returned (`provider_text`), which can echo a credential fragment and is the only field
 * that may carry it. A session is given the first part only.
 */
export interface AuthAccountCheck {
	readonly model: string;
	readonly outcome: "ok" | "failed";
	readonly code?: AuthAccountCheckCode;
	readonly message: string;
	readonly status?: number;
	readonly at: number;
	readonly provider_text?: { readonly reason?: string; readonly message?: string };
}

export type AuthAccount = Omit<CredentialAccountSummary, "check"> & { readonly check?: AuthAccountCheck };

function isCode(reason: string): reason is AuthAccountCheckCode {
	return AUTH_ACCOUNT_CHECK_CODES.some((code) => code === reason && code !== "unrecognized");
}

export function splitAccountCheck(check: CredentialAccountCheck): AuthAccountCheck {
	const code = check.reason === undefined ? undefined : isCode(check.reason) ? check.reason : "unrecognized";
	const providerReason = code === "unrecognized" ? check.reason : undefined;
	const providerText = {
		...(providerReason === undefined ? {} : { reason: providerReason }),
		...(check.message === undefined ? {} : { message: check.message }),
	};
	return {
		model: check.model,
		outcome: check.outcome,
		...(code === undefined ? {} : { code }),
		message: check.outcome === "ok" ? "connection test passed" : `connection test failed: ${code ?? "no reason"}`,
		...(check.status === undefined ? {} : { status: check.status }),
		at: check.at,
		...(Object.keys(providerText).length === 0 ? {} : { provider_text: providerText }),
	};
}

/** The stored check as the command prints it today, rebuilt from both parts in its own field order. */
export function joinAccountCheck(check: AuthAccountCheck): CredentialAccountCheck {
	const reason = check.code === "unrecognized" ? check.provider_text?.reason : check.code;
	return {
		model: check.model,
		outcome: check.outcome,
		...(reason === undefined ? {} : { reason }),
		...(check.provider_text?.message === undefined ? {} : { message: check.provider_text.message }),
		...(check.status === undefined ? {} : { status: check.status }),
		at: check.at,
	};
}

/** Overriding a key the spread already set keeps that key's place, so the printed field order does not move. */
export function splitAccount(account: CredentialAccountSummary): AuthAccount {
	const { check, ...rest } = account;
	return check === undefined ? rest : { ...account, check: splitAccountCheck(check) };
}

export function joinAccount(account: AuthAccount): CredentialAccountSummary {
	const { check, ...rest } = account;
	return check === undefined ? rest : { ...account, check: joinAccountCheck(check) };
}
