import type { SearchProvider, SearchProviderConfig } from "./types.ts";

const DEFAULT_PROVIDER_URLS: Record<Exclude<SearchProvider, "searxng">, string> = {
	exa: "https://api.exa.ai/search",
	tavily: "https://api.tavily.com/search",
	serpdive: "https://api.serpdive.com/v1/search",
	brave: "https://api.search.brave.com/res/v1/web/search",
	"duckduckgo-html": "https://html.duckduckgo.com/html/",
	deepseek: "https://api.deepseek.com/anthropic/v1/messages",
	serper: "https://google.serper.dev/search",
	"google-cse": "https://customsearch.googleapis.com/customsearch/v1",
	"z-ai": "https://api.z.ai/api/paas/v4/web_search",
	openai: "https://api.openai.com/v1/responses",
	codex: "https://api.openai.com/v1/responses",
	"chatgpt-subscription": "https://chatgpt.com/backend-api/codex/responses",
	google: "https://generativelanguage.googleapis.com/v1beta",
	anthropic: "https://api.anthropic.com/v1/messages",
	perplexity: "https://api.perplexity.ai/search",
	xai: "https://api.x.ai/v1/responses",
	kimi: "https://api.kimi.com/coding/v1/search",
	kagi: "https://kagi.com/api/v1/search",
	startpage: "https://www.startpage.com/sp/search",
	mojeek: "https://www.mojeek.com/search",
	ecosia: "https://www.ecosia.org/search",
	"google-html": "https://www.google.com/search",
	"exa-mcp": "https://mcp.exa.ai/mcp",
	keenable: "https://api.keenable.ai/v1/search",
};

/** SearXNG is self-hosted, so it has no default endpoint; config validation requires its `baseUrl`. */
export function defaultProviderUrl(provider: SearchProvider): string {
	if (provider === "searxng") throw new Error("Provider searxng requires baseUrl.");
	return DEFAULT_PROVIDER_URLS[provider];
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
	const first = parts[0] ?? -1;
	const second = parts[1] ?? -1;
	if (first === 10 || first === 127 || first === 0 || (first === 169 && second === 254)) return true;
	if (first === 172 && second >= 16 && second <= 31) return true;
	return first === 192 && second === 168;
}

function isPrivateHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		normalized.includes(":") ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab][0-9a-f]:/.test(normalized) ||
		isPrivateIpv4(normalized)
	);
}

export function isAllowedProviderBaseUrl(baseUrl: string): boolean {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return false;
	}
	return (
		configured.protocol === "https:" &&
		configured.username === "" &&
		configured.password === "" &&
		!configured.hostname.endsWith("..") &&
		!isPrivateHostname(configured.hostname)
	);
}

function isLocalNetworkHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
	if (normalized.includes(":"))
		return normalized === "::1" || /^(?:f[cd][0-9a-f]{0,2}|fe[89ab][0-9a-f]):/.test(normalized);
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		isPrivateIpv4(normalized) ||
		(!normalized.includes(".") && /^[a-z0-9-]+$/.test(normalized)) ||
		/\.(?:local|lan|internal|home\.arpa)$/.test(normalized)
	);
}

/**
 * A SearXNG instance usually runs on the user's own machine or LAN, often without TLS. Plain http is allowed
 * only for local-network hosts (loopback, private addresses, single-label and `.local`/`.lan`/`.internal`/
 * `.home.arpa` names): the URL comes from the user's own config file, not from the model, and a search sends
 * only the query. A public host must still use https so queries never cross the internet in cleartext, and
 * credentials in the URL stay rejected.
 */
export function isAllowedSearxngBaseUrl(baseUrl: string): boolean {
	let configured: URL;
	try {
		configured = new URL(baseUrl);
	} catch {
		return false;
	}
	if (configured.username !== "" || configured.password !== "" || configured.hostname === "") return false;
	if (configured.protocol === "https:") return true;
	return configured.protocol === "http:" && isLocalNetworkHostname(configured.hostname);
}

export function providerUrl(config: SearchProviderConfig): string {
	return config.baseUrl ?? defaultProviderUrl(config.provider);
}
