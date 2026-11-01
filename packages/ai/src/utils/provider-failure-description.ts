import {
	describeProviderStallForUser,
	formatStallDuration,
	isAnthropicThirdPartyBillingMessage,
	type ProviderStallDescriptionOptions,
} from "./retry.ts";

const CLAUDE_EXTRA_USAGE_URL = "https://claude.ai/settings/usage";

/**
 * `PROVIDER_NOT_CONFIGURED_PREFIX` from `../auth/resolve.ts`, repeated because importing it pulls the auth
 * modules past this entry's import budget (`check:entry-graphs`). The description test builds its input with
 * `providerNotConfiguredMessage`, so the two copies cannot drift apart.
 */
const PROVIDER_NOT_CONFIGURED_PREFIX = "Provider is not configured: ";

/**
 * Opens the sentence an adapter adds when its own account-limit text already names the next step
 * (senpi#3615). Such text is shown as written instead of the generic switch-provider advice.
 */
export const ACCOUNT_LIMIT_NEXT_STEP_LEAD = "To keep going now, ";
const RETRY_AFTER_MARKER = /\s*\(retry-after-ms: \d+\)$/;

/**
 * senpi#3259: the billing path is the whole story. On the direct `anthropic` provider a Claude
 * subscription token is billed as a third-party app, so the fix is the Agent SDK lane; on the
 * `anthropic-subscription` lane the request already ran through Claude Code, so only extra usage or
 * another model can help.
 */
function describeAnthropicThirdPartyBilling(provider: string | undefined): string {
	if (provider === "anthropic-subscription") {
		return `Anthropic billed this Claude Code request to your extra usage instead of your plan limits, and your extra usage is used up. Add extra usage at ${CLAUDE_EXTRA_USAGE_URL}, or switch to another model.`;
	}
	return `Anthropic billed this request to your extra usage instead of your Claude plan limits, because a Claude subscription used directly through the Anthropic API counts as a third-party app. Connect "Anthropic Subscription (Claude Pro/Max)" so requests run through Claude Code and use your plan limits, add extra usage at ${CLAUDE_EXTRA_USAGE_URL}, or switch to another model.`;
}

/**
 * Session-internal replay-suppression signal, read off the error text by the
 * retry predicates. A failover lane stamps it when replaying the turn could
 * duplicate side effects that already happened mid-stream. It must stay on the
 * message those predicates inspect and must never reach anything a person
 * reads; byte-identical across every lane that stamps or checks it.
 */
export const TURN_RETRY_SUPPRESSION_PREFIX = "senpi:no-turn-retry:";

export function stripTurnRetrySuppressionPrefix(message: string): string {
	return message.replaceAll(TURN_RETRY_SUPPRESSION_PREFIX, "");
}

const WEBSOCKET_CLOSED_PATTERN = /^WebSocket closed\b/i;
const WEBSOCKET_ERROR_PATTERN = /^WebSocket error$/i;
const WEBSOCKET_CONNECT_TIMEOUT_PATTERN = /^WebSocket connect timeout after (\d+)ms/i;

const RECOVERY_SENTENCE: Record<NonNullable<ProviderStallDescriptionOptions["recovery"]>, string> = {
	"no-fallback-configured":
		"No fallback model is configured for it, so nothing could take the turn over: run /fallback to add one, or send the message again to continue from the partial reply.",
	"chain-exhausted":
		"Every model in its fallback chain was tried as well: run /fallback to review the chain, or send the message again to continue from the partial reply.",
};

function transportSymptom(errorMessage: string, subject: string): string | undefined {
	if (WEBSOCKET_CLOSED_PATTERN.test(errorMessage)) {
		return `The connection to ${subject} dropped before the reply finished (${errorMessage}).`;
	}
	if (WEBSOCKET_ERROR_PATTERN.test(errorMessage)) {
		return `The connection to ${subject} reported an error before the reply finished (${errorMessage}).`;
	}
	const connectTimeout = WEBSOCKET_CONNECT_TIMEOUT_PATTERN.exec(errorMessage);
	if (connectTimeout) {
		const provider = subject.replace(/^the provider/, "The provider");
		return `${provider} did not accept the connection within ${formatStallDuration(Number(connectTimeout[1]))}.`;
	}
	return undefined;
}

/**
 * Plain-language replacement for a provider failure's own `Error.message`,
 * with the internal replay marker removed. Covers the stream-stall watchdogs
 * (delegated to {@link describeProviderStallForUser}) and WebSocket transport
 * interruptions; returns undefined for failures that have no wording here so
 * the caller can fall back to the (marker-stripped) raw text.
 */
export function describeProviderFailureForUser(
	errorMessage: string | undefined,
	options: ProviderStallDescriptionOptions & { usageLimit?: "account" | "model" } = {},
): string | undefined {
	if (!errorMessage) return undefined;
	const message = stripTurnRetrySuppressionPrefix(errorMessage).trim();
	if (!message) return undefined;
	if (isAnthropicThirdPartyBillingMessage(message)) {
		return describeAnthropicThirdPartyBilling(options.model?.split("/")[0]);
	}
	// The sentinel stays on the message for the classifiers that key on it; the reader gets the step (senpi#4329).
	if (message.startsWith(PROVIDER_NOT_CONFIGURED_PREFIX)) {
		const provider = message.slice(PROVIDER_NOT_CONFIGURED_PREFIX.length);
		return `${provider} is not connected: no API key or sign-in is saved for it. Connect the provider, or choose another model.`;
	}
	if (options.usageLimit === "account") {
		if (message.includes(ACCOUNT_LIMIT_NEXT_STEP_LEAD)) return message.replace(RETRY_AFTER_MARKER, "");
		const provider = options.model?.split("/")[0];
		const reset = /\bresets?\s+([^"}\n]+)/i
			.exec(message)?.[1]
			?.trim()
			.replace(/[.;]+$/, "");
		return `The ${provider ? `${provider} ` : ""}account usage limit has been reached${reset ? ` (resets ${reset})` : ""}. Switch to another provider, or configure another provider in retry.fallbackChains.`;
	}
	const stall = describeProviderStallForUser(message, options);
	if (stall !== undefined) return stall;

	const subject = options.model ? `the provider for ${options.model}` : "the provider";
	const symptom = transportSymptom(message, subject);
	if (symptom === undefined) return undefined;

	const sentences = [symptom];
	const attempts = options.attempts ?? 0;
	if (attempts > 0) {
		sentences.push(`Retried ${attempts} time${attempts === 1 ? "" : "s"} on the same model with the same result.`);
	}
	if (options.recovery) sentences.push(RECOVERY_SENTENCE[options.recovery]);
	return sentences.join(" ");
}

// Node: "Cannot find module '/…/chunks/x-HASH.js' imported from …"; Bun: the same with a relative
// specifier, or "ENOENT reading \"/…/chunks/x-HASH.js\"" when the file vanished after resolution.
const MISSING_MODULE_PATTERNS = [/^Cannot find module ['"]([^'"]+)['"]/, /^ENOENT reading ['"]([^'"]+)['"]/];
const SHIPPED_MODULE = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/]|file:).*\.m?js$/;

/**
 * The turn-ending message for a provider module that can no longer be imported because the
 * installed package was replaced under the running process (#2358), or undefined for any other
 * failure. It carries the no-turn-retry marker: every model in a fallback chain needs a module from
 * the same install, so a retry or fallback would only repeat the failure.
 */
export function describeReplacedInstall(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	for (const pattern of MISSING_MODULE_PATTERNS) {
		const missing = pattern.exec(error.message)?.[1];
		if (missing !== undefined && SHIPPED_MODULE.test(missing)) {
			return `${TURN_RETRY_SUPPRESSION_PREFIX}The installed package changed while this session was running, so ${missing.split(/[\\/]/).at(-1)} can no longer be loaded. Restart and resume this session to continue.`;
		}
	}
	return undefined;
}
