import { classifyErrorMessage } from "../retry.ts";
import type { RetryClassification, RetryClassifier, RetryFailure } from "./types.ts";

/**
 * Status codes Kimi's provider-request stage treats as retryable. 429 is its
 * own `rate-limited` verdict (the turn budget treats it through hint tiers);
 * the other whitelisted codes are ordinary `transient`. Every other status —
 * client errors and non-whitelisted 5xx alike — is `terminal`.
 */
const KIMI_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function classifyKimiHttpStatus(statusCode: number | undefined): RetryClassification {
	if (statusCode === undefined || !KIMI_RETRYABLE_STATUS_CODES.has(statusCode)) {
		return { verdict: "terminal" };
	}
	return statusCode === 429 ? { verdict: "rate-limited" } : { verdict: "transient" };
}

function assertNever(kind: never): never {
	throw new Error(`Unhandled retry failure kind: ${kind}`);
}

/**
 * Kimi provider-request classifier, ported from the source provider's retry
 * policy (policy only, not its code). The switch is exhaustive over
 * {@link RetryFailure}["kind"]:
 *
 * - abort / refusal / sensitive / quota-exhausted / image-format / unknown are
 *   terminal: user cancellations, content refusals, dead accounts, rejected
 *   payloads, and unrecognized failures never recover by re-sending.
 * - connection / timeout / provider failures are transient transport noise.
 * - empty-response is transient unless the model said `finishReason` was
 *   "filtered", which is a deterministic content rejection.
 * - http-status is retryable only for the whitelisted codes above.
 */
export const classifyKimiFailure: RetryClassifier = (failure) => {
	switch (failure.kind) {
		case "abort":
		case "refusal":
		case "sensitive":
		case "quota-exhausted":
		case "image-format":
		case "unknown":
			return { verdict: "terminal" };
		case "connection":
		case "timeout":
		case "provider":
			return { verdict: "transient" };
		case "empty-response":
			return failure.finishReason === "filtered" ? { verdict: "terminal" } : { verdict: "transient" };
		case "http-status":
			return classifyKimiHttpStatus(failure.statusCode);
		default:
			return assertNever(failure.kind);
	}
};

/**
 * Structured status codes the senpi default classifier treats as retryable
 * when — and only when — the message regexes have no opinion. Mirrors the
 * transient half of Kimi's table plus the Cloudflare gateway codes senpi
 * already retries by regex.
 */
const SENPI_STRUCTURED_RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
	408, 409, 429, 500, 502, 503, 504, 522, 524, 529,
]);

/** Provider error codes that prove a dead account regardless of message text. */
const SENPI_STRUCTURED_TERMINAL_PROVIDER_CODES: ReadonlySet<string> = new Set([
	"insufficient_quota",
	"credits_required",
]);

/**
 * Senpi assistant-turn classifier: the existing message regexes decide first;
 * structured failure facts are consulted only where the regexes are silent.
 *
 * Precedence (terminal wins at every tie):
 * 1. Deterministic failure kinds (abort/refusal/sensitive/quota/image-format)
 *    are terminal before any text inspection.
 * 2. A non-retryable regex match is terminal — request-shape and quota wording
 *    outrank any structured status (a 500 carrying invalid-tool-schema text
 *    stays terminal, unlike under {@link classifyKimiFailure}).
 * 3. Structured terminal facts (`shouldRetry: false`, quota provider codes).
 * 4. A retryable regex match is transient — e.g. a 400 carrying Anthropic's
 *    server-tool pairing text stays retryable because the request builder
 *    repairs the replayed history.
 * 5. Only when the regexes have no opinion does the structured status decide:
 *    whitelisted transient codes retry, everything else is terminal.
 * 6. No regex match and no structured facts: terminal, exactly the legacy
 *    boolean fallback.
 */
export const classifySenpiAssistantFailure: RetryClassifier = (failure) => {
	switch (failure.kind) {
		case "abort":
		case "refusal":
		case "sensitive":
		case "quota-exhausted":
		case "image-format":
			return { verdict: "terminal" };
	}

	const regexVerdict = classifyErrorMessage(failure.message);
	if (regexVerdict === "non-retryable") return { verdict: "terminal" };

	if (failure.shouldRetry === false) return { verdict: "terminal" };
	if (failure.providerCodes?.some((code) => SENPI_STRUCTURED_TERMINAL_PROVIDER_CODES.has(code))) {
		return { verdict: "terminal" };
	}

	if (regexVerdict === "retryable") return { verdict: "transient" };

	if (failure.statusCode !== undefined && SENPI_STRUCTURED_RETRYABLE_STATUS_CODES.has(failure.statusCode)) {
		return failure.statusCode === 429 ? { verdict: "rate-limited" } : { verdict: "transient" };
	}
	return { verdict: "terminal" };
};
