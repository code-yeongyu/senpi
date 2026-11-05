import { stripTurnRetrySuppressionPrefix } from "@earendil-works/pi-ai";

const STATUS_PHRASES: Readonly<Record<number, string>> = {
	408: "request timeout",
	429: "rate limited",
	500: "internal server error",
	502: "bad gateway",
	503: "service unavailable",
	504: "gateway timeout",
	529: "overloaded",
};

const REASON_PHRASE =
	"(?:bad request|unauthorized|forbidden|not found|request timeout|too many requests|internal server error|bad gateway|service unavailable|gateway timeout|overloaded)";

const STATUS_SOURCES: readonly RegExp[] = [
	new RegExp(`^(?:Error:\\s*)?(\\d{3})(?=\\s*(?:[:<{(]|$)|\\s+status code\\b|\\s+${REASON_PHRASE}\\b)`, "i"),
	/<title>\s*(\d{3})\b/i,
	/\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i,
	/"(?:code|status|status_code)"\s*:\s*"?(\d{3})\b/i,
];

function httpStatus(raw: string): number | undefined {
	for (const source of STATUS_SOURCES) {
		const status = Number(source.exec(raw)?.[1]);
		if (status >= 400 && status <= 599) return status;
	}
	return undefined;
}

/**
 * A few words naming why a provider request failed ("429 rate limited", "502 bad gateway"), read from the
 * raw error text a gateway returns, so the retry status and the final notice never carry the raw body
 * (a JSON envelope or an HTML error page, senpi#6012). Undefined when the text names no known cause.
 */
export function providerErrorReason(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	const raw = stripTurnRetrySuppressionPrefix(errorMessage);
	const status = httpStatus(raw);
	if (status !== undefined) {
		const phrase = STATUS_PHRASES[status] ?? (status >= 500 ? "server error" : "request failed");
		return `${status} ${phrase}`;
	}
	if (/rate.?limit|too many requests|throttl/i.test(raw)) return "rate limited";
	if (/overloaded/i.test(raw)) return "overloaded";
	if (/service unavailable/i.test(raw)) return "service unavailable";
	if (/network error|connection (?:error|lost|reset)|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(raw))
		return "network error";
	return undefined;
}
