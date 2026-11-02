import { PROVIDER_NOT_CONFIGURED_PREFIX, readProviderDiagnostic } from "@earendil-works/pi-ai";
import { DEFAULT_SLOT_BLOCK_MS, MAX_SLOT_BLOCK_MS } from "@earendil-works/pi-ai/auth/pool/failover";
import { normalizeProviderError } from "@earendil-works/pi-ai/utils/error-body";
import { ModelsError } from "@earendil-works/pi-ai/utils/models-error";
import {
	isOAuthRefreshUnavailableError,
	OAuthTokenEndpointError,
} from "@earendil-works/pi-ai/utils/oauth-refresh-error";
import { getOverflowPatterns } from "@earendil-works/pi-ai/utils/overflow";
import { extract429RetryAfterMs, parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { siwcRecoveryFromDiagnostic } from "@earendil-works/pi-ai/utils/siwc-errors";
import { rateLimitModelFamily } from "./model-scope.ts";
import { usageLimitResetMs } from "./reset-time.ts";
import { isAccountUsageLimitText } from "./usage-limit.ts";

export const COOLDOWN_BASE_MS = DEFAULT_SLOT_BLOCK_MS;
export const COOLDOWN_CAP_MS = MAX_SLOT_BLOCK_MS;
export const RETRY_SAME_MAX_ATTEMPTS = 2;

/**
 * Carried by every refusal a provider that runs its own account pool (Anthropic Subscription) makes
 * before sending anything, because the accounts it may use are blocked. That pool already holds each
 * account's real reason and deadline, so the refusal is a verdict on the pool, not on the outer slot
 * this attempt happened to run on: classifying it per slot persisted one account's auth error against
 * every slot until re-login (senpi#2081).
 */
export const ACCOUNT_POOL_REFUSAL_NOTE = "No request was sent: the account pool refused it locally.";

export type CredentialBlock =
	| { reason: "auth_error" }
	| { reason: "account_disabled" }
	| {
			reason: "rate_limit";
			cooldownMs: number;
			retryAfterWasCapped: boolean;
			/** Set when the limit names the one model family it binds ("Fable limit"). */
			modelFamily?: string;
	  };

export type CredentialAction =
	| { kind: "failover"; block: CredentialBlock }
	| { kind: "retry_same"; maxAttempts: typeof RETRY_SAME_MAX_ATTEMPTS }
	| { kind: "fail_request" };

/**
 * Per-slot exponential cooldown with the server hint as a FLOOR, never an
 * override: a hint can only lengthen the wait the failure count already earned,
 * and everything caps at 48 hours with the capping recorded.
 */
export function rateLimitCooldown(
	failureCount: number,
	serverHintMs?: number,
	policy: { baseMs?: number; capMs?: number } = {},
): { cooldownMs: number; retryAfterWasCapped: boolean } {
	const cap = policy.capMs ?? COOLDOWN_CAP_MS;
	const base = policy.baseMs ?? COOLDOWN_BASE_MS;
	const backoff = Math.min(cap, base * 2 ** Math.max(0, failureCount));
	const floored = serverHintMs === undefined ? backoff : Math.max(backoff, serverHintMs);
	return {
		cooldownMs: Math.min(cap, floored),
		retryAfterWasCapped: floored > cap,
	};
}

/** The cooldown of a spent account whose limit names a future reset: exactly until that reset, capped. */
export function usageLimitCooldown(
	resetMs: number,
	policy: { capMs?: number } = {},
): { cooldownMs: number; retryAfterWasCapped: boolean } {
	const cap = policy.capMs ?? COOLDOWN_CAP_MS;
	return { cooldownMs: Math.min(cap, resetMs), retryAfterWasCapped: resetMs > cap };
}

const INVALID_KEY_TEXT = /invalid[ _-]?(?:api[ _-]?)?key|authentication[_ ]?error|invalid x-api-key|unauthorized/i;
// Last resort for a revoked or invalidated token reported as prose with no status and no code
// (Codex: "Encountered invalidated oauth token for user, failing request", senpi#3037).
// A token qualified as a session, page or request token is not the credential, so its invalidation
// never blocks the account.
const REVOKED_TOKEN_TEXT =
	/invalidated (?:oauth )?token|(?<!\b(?:session|csrf|xsrf|page|pagination|continuation|cursor|sync|stream|upload|idempotency|request|nonce|state)[ _-])token(?:[ _-](?:invalidated|revoked)|\s(?:has been|was) (?:invalidated|revoked))/i;
// OAuth error codes with which a token endpoint refuses the refresh grant itself (RFC 6749
// `invalid_grant`, OpenAI's refresh_token_* and `token_revoked`). Besides a token endpoint's 401,
// these make a failed refresh a verdict on the account.
const REFUSED_GRANT_CODES: ReadonlySet<string> = new Set([
	"invalid_grant",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
	"token_revoked",
]);
const REFUSED_GRANT_TOKEN =
	/(?<![a-z_])(invalid_grant|refresh_token_(?:expired|invalidated|reused)|token_revoked)(?![a-z_])/;
// RFC 6749 section 5.2 codes that name a fault of the client application or of the request itself.
// They are the same for every account, so even with a 401 they never block one.
const CLIENT_FAULT_CODES: ReadonlySet<string> = new Set([
	"invalid_client",
	"invalid_request",
	"invalid_scope",
	"unauthorized_client",
	"unsupported_grant_type",
]);
// Socket, DNS and HTTP-client codes (Node, undici, Bun) with which a refresh that never got an answer
// from the token endpoint fails. Such a refresh retries the same account like any model request.
const NETWORK_FAULT_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"EHOSTDOWN",
	"ENETUNREACH",
	"ENETDOWN",
	"ENETRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
	"EADDRNOTAVAIL",
	"ERR_SOCKET_CONNECTION_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"ConnectionRefused",
	"ConnectionClosed",
	"FailedToOpenSocket",
]);
// Provider error codes that name a refused credential on a model request: the auth allowlist of the
// provider diagnostic vocabulary plus the token codes OpenAI's backends send (`token_revoked` arrives on
// a statusless Codex frame). `token_expired` is absent on purpose: an expired token that can still be
// refreshed must refresh, not block the account.
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
	"authentication_error",
	"invalid_api_key",
	"token_invalidated",
	...REFUSED_GRANT_CODES,
]);
const MAX_CAUSE_LINKS = 16;
const ACCOUNT_SCOPED_403_TEXT = /account|credential|token|api[ _-]?key|organization|subscription/i;
const RATE_LIMIT_TEXT = /rate[ _-]?limit|too many requests|resource_exhausted/i;
const BILLING_TEXT =
	/billing|credits?[ _-]?(?:required|exhausted|balance)|insufficient[ _-]?(?:funds|quota|credit)|payment[ _-]?required|quota[ _-]?exhausted/i;
const OVERLOAD_TEXT = /overloaded/i;
const NETWORK_TEXT =
	/econnreset|econnrefused|etimedout|enotfound|socket hang up|fetch failed|network error|request timed out/i;
// A WebSocket transport reports its faults as close codes and adapter
// verdicts rather than HTTP text. 1008 (policy) and 1009 (message too big)
// describe the request, so replaying it cannot help; every other closure,
// the runtime's bare error event, and the connect/liveness watchdogs are the
// transport's fault and earn the same-slot retry a reset does.
const WEBSOCKET_REQUEST_FAULT_TEXT = /websocket closed 100[89]\b/i;
const WEBSOCKET_TRANSPORT_FAULT_TEXT = /websocket (?:closed|error|connect timeout|liveness timeout)/i;
const FAIL_FAST_TEXT =
	/context[ _-]?(?:length|window)|maximum context|invalid[ _-]?model|model[ _-]?not[ _-]?found|malformed[ _-]?stream|premature[ _-]?(?:close|stream)/i;
const ABORT_TEXT = /\baborted?\b/i;
// A statusless failure that names a timeout, reset, gateway or overload is the provider's (or a
// proxy's) fault even when its text also mentions auth: unknown shapes default to temporary (senpi#2081).
const TEMPORARY_FAULT_TEXT =
	/time[ds]?[ _-]?out|timed out|disconnect|reset before|connection reset|gateway|temporarily|unavailable/i;

/**
 * What the provider's own error code, minted by the adapter from the response's structured fields,
 * says about a limit. It outranks the message prose: the ChatGPT adapter words every 429 that carries
 * an error object as a spent account, so a per-request `rate_limit_exceeded` throttle read as prose
 * blocked the account until its far window reset (senpi#3216). Undefined when no code proves either:
 * Anthropic's `rate_limit_error` comes on every 429, spent Claude windows included, so it proves neither.
 */
function limitFromProviderCode(
	error: unknown,
): { kind: "throttle" } | { kind: "spent"; resetsAt?: number } | undefined {
	const diagnostic = readProviderDiagnostic(error);
	if (diagnostic?.evidence !== "structured_code") return undefined;
	switch (diagnostic.code) {
		case "rate_limit_exceeded":
			return { kind: "throttle" };
		case "usage_limit_reached":
		case "usage_not_included":
			return diagnostic.resetsAt === undefined
				? { kind: "spent" }
				: { kind: "spent", resetsAt: diagnostic.resetsAt };
		default:
			return undefined;
	}
}

function isAbort(error: unknown, message: string): boolean {
	if (error instanceof Error && error.name === "AbortError") return true;
	return ABORT_TEXT.test(message);
}

/** The failed refresh this error reports (`ModelsError` code `oauth`, senpi#2304), if it is one. */
function failedRefresh(error: unknown): ModelsError | undefined {
	const seen = new Set<unknown>();
	while (typeof error === "object" && error !== null && !seen.has(error) && seen.size < MAX_CAUSE_LINKS) {
		seen.add(error);
		if (error instanceof ModelsError) return error.code === "oauth" ? error : undefined;
		error = Reflect.get(error, "cause");
	}
	return undefined;
}

/** The OAuth error code in a token endpoint's JSON body: `error` as a string, or `error.code`. */
function oauthBodyErrorCode(message: string): string | undefined {
	const start = message.indexOf("{");
	const end = message.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		const body: unknown = JSON.parse(message.slice(start, end + 1));
		if (typeof body !== "object" || body === null) return undefined;
		const field: unknown = Reflect.get(body, "error");
		if (typeof field === "string") return field;
		if (typeof field === "object" && field !== null) {
			const code: unknown = Reflect.get(field, "code");
			return typeof code === "string" ? code : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * The token endpoint refused this account's credential: the adapter says so (`credentialRefused`), or
 * a 401, a 400 that names a refused-grant code, or a 403/404 whose OAuth code does. An OAuth code that
 * names a client or request fault outranks both. A refresh that failed in any other way (TLS
 * interception, a captive portal's HTML, a WAF page, a moved endpoint) is not a verdict on the login.
 */
function isRefusedGrant(refresh: ModelsError): boolean {
	const cause: unknown = refresh.cause;
	if (!(cause instanceof OAuthTokenEndpointError)) return false;
	const code = cause.oauthError ?? oauthBodyErrorCode(cause.message);
	if (code !== undefined && CLIENT_FAULT_CODES.has(code)) return false;
	if (cause.credentialRefused || cause.status === 401) return true;
	if (code !== undefined && REFUSED_GRANT_CODES.has(code)) return [400, 403, 404].includes(cause.status);
	return cause.status === 400 && REFUSED_GRANT_TOKEN.test(cause.message);
}

/**
 * A failed refresh that never got an answer from the token endpoint: the first error code in its cause
 * chain is a network code, or, with no code at all, its text names a network fault. A token endpoint
 * that answered with a status is never a network fault, whatever its body says.
 */
function isRefreshNetworkFault(refresh: ModelsError, text: string): boolean {
	const seen = new Set<unknown>();
	let error: unknown = refresh.cause;
	while (typeof error === "object" && error !== null && !seen.has(error) && seen.size < MAX_CAUSE_LINKS) {
		seen.add(error);
		if (error instanceof OAuthTokenEndpointError) return false;
		const code: unknown = Reflect.get(error, "code");
		if (typeof code === "string") return NETWORK_FAULT_CODES.has(code);
		error = Reflect.get(error, "cause");
	}
	return NETWORK_TEXT.test(text);
}

/** A structured provider diagnostic that names a refused credential, with or without a status. */
function hasAuthDiagnostic(error: unknown): boolean {
	const diagnostic = readProviderDiagnostic(error);
	if (diagnostic === undefined) return false;
	return diagnostic.category === "auth" || (diagnostic.code !== undefined && AUTH_ERROR_CODES.has(diagnostic.code));
}

function isOverflowText(text: string): boolean {
	return getOverflowPatterns().some((pattern) => pattern.test(text));
}

/**
 * Maps a provider failure onto the credential-pool action space. Credential-
 * scoped failures fail over (permanently for auth/billing, cooldown for rate
 * limits); provider-scoped faults (5xx/overload/network) retry the SAME slot
 * without blocking it, because blocking a healthy credential for a provider
 * outage only destroys prompt-cache locality; everything else fails the
 * request so the model fallback chain above keeps owning it.
 */
export function classifyCredentialFailure(
	error: unknown,
	context: { failureCount?: number; cooldownBaseMs?: number; cooldownCapMs?: number; nowMs?: number } = {},
): CredentialAction {
	if (isOAuthRefreshUnavailableError(error)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	const normalized = normalizeProviderError(error);
	const text = normalized.messageCarriesBody ? normalized.message : `${normalized.message} ${normalized.body ?? ""}`;
	const status = normalized.status;
	const failureCount = context.failureCount ?? 0;

	if (error instanceof Error && error.name === "AbortError") return { kind: "fail_request" };
	const siwc = siwcRecoveryFromDiagnostic(readProviderDiagnostic(error));
	switch (siwc) {
		case "usage_limit":
			// No provider reset is known. This is a guessed probe cooldown, not a reset
			// time; ignore reset-like prose and cap the guess at #5034's 30 minutes.
			return {
				kind: "failover",
				block: {
					reason: "rate_limit",
					...rateLimitCooldown(failureCount, undefined, {
						baseMs: context.cooldownBaseMs,
						capMs: Math.min(context.cooldownCapMs ?? COOLDOWN_CAP_MS, 30 * 60_000),
					}),
				},
			};
		case "account_disabled":
			return { kind: "failover", block: { reason: "account_disabled" } };
		case "auth":
			return { kind: "failover", block: { reason: "auth_error" } };
		case "request":
			return { kind: "fail_request" };
		case "transient":
			return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
		case undefined:
			break;
	}
	if (isAbort(error, text)) return { kind: "fail_request" };
	if (text.includes(ACCOUNT_POOL_REFUSAL_NOTE)) return { kind: "fail_request" };
	// A server, gateway or timeout status describes the provider, not the credential: its body may
	// echo words like "unauthorized" or "billing", but only the status says what failed (senpi#2081).
	const providerFault =
		status === 408 ||
		(status !== undefined && status >= 500 && status < 600) ||
		(status === undefined &&
			(TEMPORARY_FAULT_TEXT.test(text) || NETWORK_TEXT.test(text) || OVERLOAD_TEXT.test(text)));
	const codedLimit = limitFromProviderCode(error);
	const usageLimit =
		codedLimit !== undefined ? codedLimit.kind === "spent" : isAccountUsageLimitText(text) && !isOverflowText(text);
	const limitText = codedLimit !== undefined || RATE_LIMIT_TEXT.test(text) || usageLimit;
	// A slot whose material no longer resolves to usable auth is a per-credential
	// fault, not a provider-wide one: failing the request here would let ONE bad
	// slot dead-end a pool whose siblings are healthy. The block is permanent
	// because only a re-login or a repaired entry can change that answer.
	if (text.includes(PROVIDER_NOT_CONFIGURED_PREFIX)) {
		return { kind: "failover", block: { reason: "auth_error" } };
	}
	// Structured auth evidence is a verdict on this one account, so it fails over to a sibling before
	// any auth prose is read; a provider fault or rate-limit status still says the login did not fail.
	const statusFault = status === 408 || status === 429 || (status !== undefined && status >= 500 && status < 600);
	const refresh = failedRefresh(error);
	if (refresh !== undefined) {
		if (!statusFault && isRefusedGrant(refresh)) return { kind: "failover", block: { reason: "auth_error" } };
		// Any other failed refresh is not a verdict on this account, so no branch below may block it; a
		// network fault still retries the same account as it does for a model request (senpi#2081).
		return isRefreshNetworkFault(refresh, text)
			? { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS }
			: { kind: "fail_request" };
	}
	if (!providerFault && status !== 429 && hasAuthDiagnostic(error)) {
		return { kind: "failover", block: { reason: "auth_error" } };
	}
	// Only a 401, or auth text on a response whose status cannot mean something temporary, is an auth
	// rejection; a 429 that mentions authentication is still a rate limit and cools down.
	if (
		status === 401 ||
		(!providerFault && status !== 429 && (INVALID_KEY_TEXT.test(text) || REVOKED_TOKEN_TEXT.test(text)))
	) {
		return { kind: "failover", block: { reason: "auth_error" } };
	}
	if (status === 403 && !limitText) {
		return ACCOUNT_SCOPED_403_TEXT.test(text)
			? { kind: "failover", block: { reason: "auth_error" } }
			: { kind: "fail_request" };
	}
	if (status === 402 || (!providerFault && BILLING_TEXT.test(text))) {
		return { kind: "failover", block: { reason: "account_disabled" } };
	}
	// Subscription usage limits often arrive as prose with no status (#1768).
	// Overflow prose is excluded (`usageLimit` above) because this branch runs
	// before the overflow branch below.
	if (status === 429 || limitText) {
		const nowMs = context.nowMs ?? Date.now();
		// A spent account is out until its reset time, so that time (a reset
		// header, a reset field or reset prose) floors its cooldown; without one,
		// the default cooldown stands. Plain rate limits keep today's hint only.
		// A coded throttle's text is the adapter's spent-account wording, so neither it nor the window
		// reset it names is this throttle's wait; only the server's Retry-After header (the adapter's
		// marker) is. A coded spent account's reset is the diagnostic's own; one already past proves
		// nothing, so the reset the response names still decides.
		const codedResetMs =
			codedLimit?.kind === "spent" && codedLimit.resetsAt !== undefined ? codedLimit.resetsAt - nowMs : undefined;
		const codedReset = codedResetMs !== undefined && codedResetMs > 0 ? codedResetMs : undefined;
		const hint =
			codedLimit?.kind === "throttle"
				? parseRetryAfterMsMarker(text)
				: (codedReset ??
					extract429RetryAfterMs({ status: status ?? 429, bodyText: text }, nowMs) ??
					(usageLimit ? (normalized.retryAfterMs ?? usageLimitResetMs(text, nowMs)) : undefined));
		const modelFamily = rateLimitModelFamily(text);
		const policy = { baseMs: context.cooldownBaseMs, capMs: context.cooldownCapMs };
		return {
			kind: "failover",
			block: {
				reason: "rate_limit",
				// A spent account comes back at the reset it names, so that reset is the cooldown: an
				// exponential backoff grown from earlier failures would keep it blocked past it (senpi#3771).
				// A reset already past (clock skew, a stale string) proves nothing and keeps the default floor.
				...(usageLimit && hint !== undefined && hint > 0
					? usageLimitCooldown(hint, policy)
					: rateLimitCooldown(failureCount, hint, policy)),
				...(modelFamily === undefined ? {} : { modelFamily }),
			},
		};
	}
	if (isOverflowText(text) || status === 400 || status === 404 || FAIL_FAST_TEXT.test(text)) {
		return { kind: "fail_request" };
	}
	if (WEBSOCKET_REQUEST_FAULT_TEXT.test(text)) return { kind: "fail_request" };
	if (WEBSOCKET_TRANSPORT_FAULT_TEXT.test(text)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	if (status === 529 || OVERLOAD_TEXT.test(text) || (status !== undefined && status >= 500 && status < 600)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	if (status === 408 || NETWORK_TEXT.test(text)) {
		return { kind: "retry_same", maxAttempts: RETRY_SAME_MAX_ATTEMPTS };
	}
	return { kind: "fail_request" };
}
