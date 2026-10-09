export type SearchProvider =
	| "exa"
	| "tavily"
	| "serpdive"
	| "brave"
	| "duckduckgo-html"
	| "deepseek"
	| "serper"
	| "google-cse"
	| "z-ai"
	| "openai"
	| "codex"
	| "chatgpt-subscription"
	| "google"
	| "anthropic"
	| "perplexity"
	| "xai"
	| "kimi"
	| "kagi"
	| "startpage"
	| "mojeek"
	| "ecosia"
	| "google-html"
	| "exa-mcp"
	| "searxng"
	| "keenable";

/** Why a keyless engine refused a search; each reason puts the engine on a cooldown. */
export type SearchBlockReason = "challenge" | "rate_limited" | "forbidden" | "network";

export type SearchContextSize = "low" | "medium" | "high";
export type CodexSearchMode = "cached" | "live";
export type RoutingStrategy = "priority" | "round-robin" | "fill-first";

export interface SearchProviderConfig {
	id?: string;
	provider: SearchProvider;
	apiKey?: string;
	baseUrl?: string;
	/** Extra request headers the session credential requires; resolved from the model registry, never read from websearch.json. */
	headers?: Record<string, string>;
	searchEngineId?: string;
	maxResults?: number;
	model?: string;
	codexMode?: CodexSearchMode;
	searchContextSize?: SearchContextSize;
	allowedDomains?: string[];
	blockedDomains?: string[];
	userLocation?: SearchUserLocation;
	timeoutMs?: number;
}

export interface SearchProviderEntry extends SearchProviderConfig {
	priority?: number;
	weight?: number;
	fallbackModel?: string;
}

export interface WebsearchConfig {
	strategy: RoutingStrategy;
	fallback: boolean;
	auto: boolean;
	nativeModel?: string;
	providers: SearchProviderEntry[];
}

export interface SearchUserLocation {
	country?: string;
	region?: string;
	city?: string;
	timezone?: string;
}

export interface SearchRequest {
	query: string;
	maxResults: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export interface BuiltSearchRequest {
	url: string;
	init: {
		method: "GET" | "POST";
		headers: Record<string, string>;
	};
	body?: JsonObject;
	/** A pre-encoded `application/x-www-form-urlencoded` body, sent instead of `body`. */
	form?: string;
}

export interface SearchResultItem {
	title: string;
	url: string;
	snippet?: string;
	score?: number;
	source?: string;
	publishedAt?: string;
}

export interface SearchDetails {
	provider: SearchProvider;
	entryId?: string;
	model?: string;
	query: string;
	results: SearchResultItem[];
	durationMs: number;
	truncated: boolean;
	strategy?: RoutingStrategy;
	attempts?: SearchAttempt[];
	answer?: string;
	error?: string;
	blocked?: SearchBlockReason;
	/** Seconds from a `Retry-After` response header. */
	retryAfterSeconds?: number;
}

export interface SearchProgressDetails {
	phase: "searching";
	query: string;
	providerLabels: string[];
	maxResults: number;
	currentProvider?: string;
	attempts?: SearchAttempt[];
	routeLabels?: string[];
	strategy?: RoutingStrategy;
	allowedDomains?: string[];
	blockedDomains?: string[];
}

export type ConfigLoadFailureReason =
	| "missing_config"
	| "invalid_config"
	| "missing_api_key"
	| "provider_native_bypass";

export interface SearchErrorDetails {
	phase: "error";
	query: string;
	error: string;
	reason?: ConfigLoadFailureReason;
}

export type SearchRenderDetails = SearchDetails | SearchProgressDetails | SearchErrorDetails;

export interface SearchAttempt {
	provider: SearchProvider;
	entryId?: string;
	model?: string;
	durationMs: number;
	resultsCount: number;
	error?: string;
	blocked?: SearchBlockReason;
	/** The engine was not queried because it is cooling down after an earlier block. */
	skipped?: boolean;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
	[key: string]: JsonValue;
}

export type ConfigLoadResult =
	| { ok: true; config: WebsearchConfig; source: string }
	| {
			ok: false;
			reason: ConfigLoadFailureReason;
			message: string;
			source?: string;
	  };

export type ProviderValidationResult =
	| { ok: true; config: SearchProviderEntry }
	| { ok: false; reason: "invalid_config" | "missing_api_key"; message: string };
