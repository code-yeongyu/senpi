import type { AccountSlot } from "./accounts.ts";

const SIGN_IN_AGAIN_LEAD = "Claude sign-in changed. Sign in again with Claude to keep using: ";

/** The one prompt every surface shows for accounts from the retired sign-in (senpi#4436): notice, turn error, docs. */
export function signInAgainMessage(names: readonly string[]): string {
	return `${SIGN_IN_AGAIN_LEAD}${names.join(", ")}. Run /login anthropic-subscription.`;
}

/** A turn error that is the sign-in-again prompt: no retry or other model can serve it until the user signs in. */
export function isSignInAgainError(errorMessage: string | undefined): boolean {
	return errorMessage?.includes(`authentication_failed: ${SIGN_IN_AGAIN_LEAD}`) === true;
}

export function signInRequiredNames(accounts: readonly AccountSlot[]): string[] {
	return accounts.filter((slot) => slot.store === "claude-cli" && slot.signInRequired).map((slot) => slot.name);
}

/** A turn found only accounts that must sign in again; the message is the prompt, prefixed so it classifies as auth. */
export class ClaudeSignInRequiredError extends Error {
	readonly accountNames: readonly string[];

	constructor(accountNames: readonly string[]) {
		super(`authentication_failed: ${signInAgainMessage(accountNames)}`);
		this.name = "ClaudeSignInRequiredError";
		this.accountNames = accountNames;
	}
}
