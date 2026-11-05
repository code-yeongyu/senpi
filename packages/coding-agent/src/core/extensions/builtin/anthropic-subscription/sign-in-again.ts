import type { AccountSlot, ClaudeCliAccountSlot } from "./accounts.ts";

/** Every sign-in-required prompt starts with this, whatever the reason; `isSignInAgainError` keys on it. */
const SIGN_IN_LEAD = "Claude sign-in ";
const SIGN_IN_AGAIN_TAIL = "Sign in again with Claude to keep using: ";

export type SignInRequiredReason = NonNullable<ClaudeCliAccountSlot["signInRequired"]>;
export type SignInRequired = { readonly name: string; readonly reason: SignInRequiredReason };

const REASON_WORD: Record<SignInRequiredReason, string> = {
	legacy_sign_in_retired: "changed",
	login_expired: "expired",
};
const REASON_ORDER: readonly SignInRequiredReason[] = ["legacy_sign_in_retired", "login_expired"];

function reasonMessage(reason: SignInRequiredReason, names: readonly string[]): string {
	return `${SIGN_IN_LEAD}${REASON_WORD[reason]}. ${SIGN_IN_AGAIN_TAIL}${names.join(", ")}. Run /login anthropic-subscription.`;
}

/** The one prompt every surface shows for accounts from the retired sign-in (senpi#4436): notice, turn error, docs. */
export function signInAgainMessage(names: readonly string[]): string {
	return reasonMessage("legacy_sign_in_retired", names);
}

/** One sentence per reason, the retired sign-in first; an expired CLI login (senpi#5350) says "expired". */
export function signInRequiredMessage(required: readonly SignInRequired[]): string {
	return REASON_ORDER.map((reason) => [reason, required.filter((entry) => entry.reason === reason)] as const)
		.filter(([, entries]) => entries.length > 0)
		.map(([reason, entries]) =>
			reasonMessage(
				reason,
				entries.map((entry) => entry.name),
			),
		)
		.join(" ");
}

/** A turn error that is a sign-in-required prompt: no retry or other model can serve it until the user signs in. */
export function isSignInAgainError(errorMessage: string | undefined): boolean {
	return errorMessage?.includes(`authentication_failed: ${SIGN_IN_LEAD}`) === true;
}

export function signInRequiredAccounts(accounts: readonly AccountSlot[]): SignInRequired[] {
	return accounts.flatMap((slot) =>
		slot.store === "claude-cli" && slot.signInRequired !== undefined
			? [{ name: slot.name, reason: slot.signInRequired }]
			: [],
	);
}

/**
 * A turn found only accounts that must sign in again; the message is the prompt, prefixed so it classifies as auth.
 * A bare name is an account from the retired sign-in.
 */
export class ClaudeSignInRequiredError extends Error {
	readonly accountNames: readonly string[];

	constructor(accounts: readonly (string | SignInRequired)[]) {
		const required = accounts.map((entry) =>
			typeof entry === "string" ? { name: entry, reason: "legacy_sign_in_retired" as const } : entry,
		);
		super(`authentication_failed: ${signInRequiredMessage(required)}`);
		this.name = "ClaudeSignInRequiredError";
		this.accountNames = required.map((entry) => entry.name);
	}
}
