import { join } from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME, CONFIG_FLAT_LAYOUT, getAgentDir } from "../../../../config.ts";
import { brandEnvNames } from "../../../brand.ts";
import type { PinSource } from "./affinity.ts";
import type { AuthenticatedAttemptInput } from "./auth-attempt.ts";
import { seatDigest } from "./seat-digest.ts";
import { logContinuityEvent } from "./session-observability.ts";

type AccountContext = {
	readonly accountLabel: string;
	readonly accountSource: "login" | "import" | "env" | "ambient" | "unknown";
	readonly pinSource?: PinSource;
};

// Context follows the actual SDK event/error, not the session: overlapping turns and failover
// must never borrow another attempt's account. Weak keys retain neither completed turns nor tokens.
const contexts = new WeakMap<object, AccountContext>();

export function attemptAccountContext(auth: AuthenticatedAttemptInput): AccountContext {
	return {
		// Operational account names, unlike displayName, cannot contain an email or org identifier.
		accountLabel: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(auth.accountName) ? auth.accountName : "configured account",
		accountSource:
			auth.authLane === "ambient"
				? "ambient"
				: (auth.accounts.find((account) => account.name === auth.accountName)?.source ?? "unknown"),
		...(auth.pinSource === undefined ? {} : { pinSource: auth.pinSource }),
	};
}

export function rememberAccountContext(target: unknown, context: AccountContext): void {
	if (target !== null && typeof target === "object") contexts.set(target, context);
}

/** Keep the original SDK error and its usage/classification unchanged. */
export function inheritAccountContext<T extends Error>(event: object, error: T): T {
	const context = contexts.get(event);
	if (context) contexts.set(error, context);
	return error;
}

export function errorAccountContext(error: unknown): AccountContext | undefined {
	return error !== null && typeof error === "object" ? contexts.get(error) : undefined;
}

export function logAttemptAccount(auth: AuthenticatedAttemptInput, sessionId: string | undefined): void {
	const agentDir = getAgentDir();
	// This is the config resolver's exact prefix order, including explicitly empty selectors.
	const selector = brandEnvNames("CODING_AGENT_DIR").find((name) => process.env[name] !== undefined);
	const defaultDir = CONFIG_FLAT_LAYOUT ? join(homedir(), CONFIG_DIR_NAME) : join(homedir(), CONFIG_DIR_NAME, "agent");
	const agentDirSource =
		selector !== undefined && process.env[selector] ? selector : agentDir === defaultDir ? "default" : "project";
	logContinuityEvent("claude_sdk_oauth_session_auth", {
		...(sessionId === undefined ? {} : { sessionId }),
		agentDir: `dir:${seatDigest(`agent-dir:${agentDir}`, agentDir)}`,
		agentDirSource,
		agentDirRule:
			selector !== undefined && process.env[selector]
				? "environment"
				: agentDir === defaultDir
					? "home-default"
					: "project-local",
		seat: seatDigest(auth.accountName, agentDir),
		accountSource: attemptAccountContext(auth).accountSource,
	});
}
