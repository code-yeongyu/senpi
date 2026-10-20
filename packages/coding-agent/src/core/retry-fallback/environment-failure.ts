import { isProviderStreamStallText, stripProviderRequestIds } from "@earendil-works/pi-ai/utils/retry";
import { isPureNetworkTransient } from "./transient-network.ts";

/**
 * A failure of this machine, its account, or its network rather than of the model. Every other
 * model on the chain meets the same wall (the same missing Claude Code, the same rejected key, the
 * same dead connection), so a fallback only hides the cause behind a second failure (desktop#3464).
 */
export type EnvironmentFailure = "executable" | "auth" | "network";

// The provider's local binary is missing or cannot be launched: senpi's own resolver error, the
// Claude Agent SDK's, a spawn refusal, or the Windows shell's "not recognized" for a bare command.
const EXECUTABLE_UNAVAILABLE =
	/executable not found|native binary not found|spawn \S+ (?:enoent|eacces|eperm|unknown)|is not recognized as an internal or external command/;

// The provider refused who we are, not what we asked: a 401, a rejected or expired key or token,
// or a signed-out CLI. A 403 is deliberately absent: it also means "no access to this model",
// which another model can answer.
const AUTH_REJECTED =
	/\b401\b|unauthori[sz]ed|authentication_error|invalid (?:x-)?api[ -_]?key|invalid bearer token|(?:oauth |access )?token (?:has )?expired|not logged in|please run \/login/;

// A 400 that refuses the credential rather than the request: Anthropic's "This API key is not scoped
// to a workspace", or any invalid_request whose message names the key or the workspace.
const CREDENTIAL_REQUEST_REJECTED =
	/not scoped to (?:a|any) workspace|invalid_request_error[^\n]*\b(?:api[ -_]?key|workspace)\b/;

export function environmentFailure(errorMessage: string | undefined): EnvironmentFailure | undefined {
	if (errorMessage === undefined) return undefined;
	const message = stripProviderRequestIds(errorMessage).toLowerCase();
	if (EXECUTABLE_UNAVAILABLE.test(message)) return "executable";
	if (AUTH_REJECTED.test(message) || CREDENTIAL_REQUEST_REJECTED.test(message)) return "auth";
	// A stream watchdog stall reached the provider, which then went quiet: that is the model's
	// overload, not the network's, so it keeps its escalation to the chain.
	if (isPureNetworkTransient(errorMessage) && !isProviderStreamStallText(errorMessage)) return "network";
	return undefined;
}
