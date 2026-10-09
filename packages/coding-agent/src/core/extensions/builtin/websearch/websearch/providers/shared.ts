import type {
	BuiltSearchRequest,
	JsonObject,
	JsonValue,
	SearchProviderConfig,
	SearchRequest,
	SearchResultItem,
} from "../types.ts";

const EMPTY_DOMAIN_SENTINEL = "invalid.invalid";

export interface BuildContext {
	config: SearchProviderConfig;
	request: SearchRequest;
	maxResults: number;
	allowedDomains: string[] | undefined;
	blockedDomains: string[] | undefined;
}

/** A response body as read, with the status and the final URL after redirects. */
export interface FetchedPage {
	status: number;
	url: string;
	body: string;
}

export type PageFetcher = (request: BuiltSearchRequest) => Promise<FetchedPage>;

/** `json` bodies are parsed; `html` bodies arrive as `{ html, url }`; `event-stream` bodies as the first JSON `data:` message. */
export type ResponseFormat = "json" | "html" | "event-stream";

export interface ProviderModule {
	buildRequest(ctx: BuildContext): BuiltSearchRequest;
	normalizeResponse?(data: JsonObject): SearchResultItem[];
	/** Turns a non-JSON response body (for example a server-sent event stream) into the payload `normalizeResponse` reads. */
	parseBody?(bodyText: string): JsonObject;
	/** HTML engines read the parsed results page; the parser loads lazily on first use. */
	normalizeDocument?(document: Document): SearchResultItem[];
	responseFormat?: ResponseFormat;
	/** Names the bot challenge the page is, or returns undefined for a real answer. Runs before status handling. */
	detectChallenge?(page: FetchedPage): string | undefined;
	/** Reports an error the service returned inside a successful response. */
	responseError?(data: JsonObject): string | undefined;
	/** Runs a handshake before the search request; returns the request to send, or the challenge that blocked the handshake. */
	prepareRequest?(
		ctx: BuildContext,
		built: BuiltSearchRequest,
		fetchPage: PageFetcher,
	): Promise<BuiltSearchRequest | { challenge: string }>;
}

/**
 * One stable desktop Chrome navigation fingerprint. The HTML engines serve their plain result pages to a
 * browser navigation and a bot page to anything that looks like a script.
 */
export function browserHeaders(referer?: string, extra?: Record<string, string>): Record<string, string> {
	return {
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		"Sec-Fetch-Dest": "document",
		"Sec-Fetch-Mode": "navigate",
		"Sec-Fetch-Site": referer ? "same-origin" : "none",
		"Sec-Fetch-User": "?1",
		"Upgrade-Insecure-Requests": "1",
		...(referer ? { Referer: referer } : {}),
		...(extra ?? {}),
	};
}

/** Collapses whitespace; returns undefined for a missing or blank value. */
export function cleanText(value: string | null | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > 0 ? text : undefined;
}

/** Accepts an http(s) result link that leaves the engine's own site. */
export function externalResultUrl(
	href: string | null | undefined,
	base: string,
	ownHosts: readonly string[],
): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, base);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const host = url.hostname.toLowerCase();
	if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) return undefined;
	return url.href;
}

/** Keeps the first result for each URL. */
export function uniqueByUrl(items: SearchResultItem[]): SearchResultItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.url)) return false;
		seen.add(item.url);
		return true;
	});
}

export function contentHeaders(extra?: Record<string, string>): Record<string, string> {
	return { Accept: "application/json", "Content-Type": "application/json", ...(extra ?? {}) };
}

/** Credential headers resolved from the session login, underneath the provider's own request headers. */
export function withConfigHeaders(
	config: SearchProviderConfig,
	headers: Record<string, string>,
): Record<string, string> {
	const merged = new Headers(config.headers);
	for (const [name, value] of Object.entries(headers)) merged.set(name, value);
	return Object.fromEntries(merged.entries());
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function appendDomainFilters(query: string, allowedDomains?: string[], blockedDomains?: string[]): string {
	const parts = [query];
	for (const domain of allowedDomains ?? []) parts.push(`site:${domain}`);
	for (const domain of blockedDomains ?? []) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

export function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function nonEmptyDomains(values: string[]): string[] {
	return values.length > 0 ? values : [EMPTY_DOMAIN_SENTINEL];
}

export function resolveDomainFilters(
	config: SearchProviderConfig,
	request: SearchRequest,
): { allowedDomains?: string[]; blockedDomains?: string[] } {
	const configAllowed = config.allowedDomains;
	const configBlocked = config.blockedDomains;
	const requestAllowed = request.allowedDomains;
	const requestBlocked = request.blockedDomains;

	if (configAllowed) {
		const narrowed = requestAllowed
			? configAllowed.filter((domain) => requestAllowed.includes(domain))
			: configAllowed;
		const allowed = requestBlocked ? narrowed.filter((domain) => !requestBlocked.includes(domain)) : narrowed;
		return { allowedDomains: nonEmptyDomains(unique(allowed)) };
	}

	if (configBlocked) {
		const blocked = unique([...configBlocked, ...(requestBlocked ?? [])]);
		if (requestAllowed) {
			return { allowedDomains: nonEmptyDomains(requestAllowed.filter((domain) => !blocked.includes(domain))) };
		}
		return { blockedDomains: blocked };
	}

	if (requestAllowed) return { allowedDomains: unique(requestAllowed) };
	if (requestBlocked) return { blockedDomains: unique(requestBlocked) };
	return {};
}

export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getObject(value: JsonValue | undefined): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

export function getArray(value: JsonValue | undefined): JsonValue[] {
	return Array.isArray(value) ? value : [];
}

export function getString(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function getNumber(value: JsonValue | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function result(
	title: string | undefined,
	url: string | undefined,
	snippet?: string,
	source?: string,
	score?: number,
): SearchResultItem | null {
	if (!title || !url) return null;
	const item: SearchResultItem = { title, url };
	if (snippet) item.snippet = snippet;
	if (source) item.source = source;
	if (score !== undefined) item.score = score;
	return item;
}

export function collect(items: Array<SearchResultItem | null>, max = 50): SearchResultItem[] {
	return items.filter((item): item is SearchResultItem => item !== null).slice(0, max);
}

export function parseObjectPayload(payload: unknown): JsonObject {
	if (isJsonObject(payload)) return payload;
	return {};
}
