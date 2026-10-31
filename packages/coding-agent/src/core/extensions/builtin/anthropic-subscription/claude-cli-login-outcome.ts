import type { ClaudeCliAccountCheck } from "./accounts.ts";

/** The account a Claude CLI sign-in signed in and its connection test, for the client that started that login. */
export type ClaudeCliLoginOutcome = { account: { name: string }; check: ClaudeCliAccountCheck };

const outcomes = new WeakMap<AbortSignal, ClaudeCliLoginOutcome>();

/** Keyed by the login's own signal, so two concurrent logins never see each other's outcome. */
export function recordClaudeCliLoginOutcome(signal: AbortSignal, outcome: ClaudeCliLoginOutcome): void {
	outcomes.set(signal, outcome);
}

/** The outcome of the CLI sign-in that ran under `signal`, taken once. */
export function takeClaudeCliLoginOutcome(signal: AbortSignal | undefined): ClaudeCliLoginOutcome | undefined {
	if (signal === undefined) return undefined;
	const outcome = outcomes.get(signal);
	outcomes.delete(signal);
	return outcome;
}
