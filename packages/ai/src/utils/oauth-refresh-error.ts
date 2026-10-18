import { ModelsError } from "./models-error.ts";

export class OAuthTokenEndpointError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

const TRANSPORT_CODES = new Set([
	"ConnectionRefused",
	"FailedToOpenSocket",
	"ConnectionClosed",
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ETIMEDOUT",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_SOCKET",
]);

/** Both cause walks are bounded as well as cycle-safe: a refresh failure's cause chain is a few links deep. */
const MAX_CAUSE_LINKS = 16;

/** Closed, log-safe facts only; never inspect the message or response body. */
export function oauthRefreshFailureCause(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	while (typeof error === "object" && error !== null && !seen.has(error) && seen.size < MAX_CAUSE_LINKS) {
		seen.add(error);
		if (Reflect.get(error, "name") === "TimeoutError") return "timeout";
		const code: unknown = Reflect.get(error, "code");
		if (typeof code === "string" && TRANSPORT_CODES.has(code)) {
			return code === "ConnectionRefused" || code === "ECONNREFUSED" ? "connection_refused" : code.toLowerCase();
		}
		const status: unknown = Reflect.get(error, "status");
		if (typeof status === "number" && (status === 408 || status === 429 || (status >= 500 && status < 600))) {
			return `http_${status}`;
		}
		error = Reflect.get(error, "cause");
	}
	return undefined;
}

export function classifyOAuthRefreshFailure(error: unknown): "transient" | "permanent" {
	return oauthRefreshFailureCause(error) === undefined ? "permanent" : "transient";
}

const UNAVAILABLE = Symbol.for("senpi.oauthRefreshUnavailable");

export class OAuthRefreshUnavailableError extends ModelsError {
	readonly [UNAVAILABLE] = true;

	constructor(provider: string, cause: unknown) {
		super("oauth", `OAuth refresh failed for ${provider}`, { cause });
		this.name = "OAuthRefreshUnavailableError";
	}
}

export function isOAuthRefreshUnavailableError(error: unknown): error is OAuthRefreshUnavailableError {
	const seen = new Set<unknown>();
	while (typeof error === "object" && error !== null && !seen.has(error) && seen.size < MAX_CAUSE_LINKS) {
		seen.add(error);
		if (Reflect.get(error, UNAVAILABLE) === true) return true;
		error = Reflect.get(error, "cause");
	}
	return false;
}
