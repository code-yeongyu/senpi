import { describeProviderStallForUser, formatStallDuration, type ProviderStallDescriptionOptions } from "./retry.ts";

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
	options: ProviderStallDescriptionOptions = {},
): string | undefined {
	if (!errorMessage) return undefined;
	const message = stripTurnRetrySuppressionPrefix(errorMessage).trim();
	if (!message) return undefined;
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
