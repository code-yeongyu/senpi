/**
 * Listing URL for `senpi models discover` (senpi#2196): the request keeps the configured URL exactly,
 * while everything printed (reports and errors) uses a display form with the userinfo removed and
 * every query value redacted, because a configured base URL may carry a key.
 */

export interface ListingUrl {
	/** Sent on the wire, unchanged apart from the `/models` path segment. */
	readonly request: string;
	/** Safe to print. */
	readonly display: string;
}

export function displayUrl(url: URL): string {
	const query = [...url.searchParams.keys()].map((name) => `${encodeURIComponent(name)}=<redacted>`).join("&");
	return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

/** `<baseUrl>/models`, or undefined when the base URL does not parse. */
export function listingUrl(baseUrl: string): ListingUrl | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return undefined;
	}
	url.pathname = `${url.pathname.replace(/\/+$/u, "")}/models`;
	return { request: url.toString(), display: displayUrl(url) };
}

/** An error message with the request URL, and any other userinfo, replaced by safe text. */
export function redactUrlInMessage(message: string, url: ListingUrl): string {
	return message
		.split(url.request)
		.join(url.display)
		.replace(/\/\/[^/\s@]+@/gu, "//");
}
