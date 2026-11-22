import { stripProviderRequestIds } from "@earendil-works/pi-ai/utils/retry";

// Transport blips (timeouts, DNS, socket drops, a cut stream); shared by the cooldown and the fallback decision.
const TRANSPORT_FAILURE =
	/timed? out|timeout|econnreset|econnrefused|etimedout|socket hang up|socket connection was closed|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|enotfound|eai_again|upstream.?connect|reset before headers|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|\btls\b|\bssl\b|econnaborted|epipe/;

// A limit, spent account, loaded model or server-side failure (5xx, "unavailable") is the provider's
// answer, even beside a timeout, matching the precedence in cooldown.ts.
const PROVIDER_VERDICT =
	/usage[- ]limit|quota|billing|credits|rate[ -]?limit|\b429\b|too many requests|overloaded|capacity|forbidden|resets? (?:at|in)\b|\b5\d\d\b|server|unavailable|high demand|overflow/;

function normalize(errorMessage: string): string {
	return stripProviderRequestIds(errorMessage).toLowerCase();
}

export function isTransportFailureText(normalizedMessage: string): boolean {
	return TRANSPORT_FAILURE.test(normalizedMessage);
}

export function isPureNetworkTransient(errorMessage: string | undefined): boolean {
	if (errorMessage === undefined) return false;
	const message = normalize(errorMessage);
	return isTransportFailureText(message) && !PROVIDER_VERDICT.test(message);
}
