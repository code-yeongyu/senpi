import { KEYLESS_PROVIDERS } from "./config.ts";
import type { FetchedPage } from "./providers/shared.ts";
import {
	detectSearchChallenge,
	normalizeSearchResponse,
	parseProviderBody,
	prepareSearchRequest,
	searchResponseError,
	searchResponseFormat,
} from "./providers.ts";
import { attemptRouteLabel, providerEntryLabel, routeAttemptEntries } from "./route-attempts.ts";
import type {
	BuiltSearchRequest,
	JsonObject,
	RoutingStrategy,
	SearchAttempt,
	SearchBlockReason,
	SearchDetails,
	SearchProvider,
	SearchProviderEntry,
	SearchRequest,
	WebsearchConfig,
} from "./types.ts";

const MAX_ERROR_DETAIL_LENGTH = 500;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
/** First cooldown after a keyless engine blocks a search; each consecutive block doubles it up to the cap. */
export const ENGINE_COOLDOWN_BASE_MS = 60_000;
export const ENGINE_COOLDOWN_MAX_MS = 15 * 60_000;

const ENGINE_NAMES: Partial<Record<SearchProvider, string>> = {
	"duckduckgo-html": "DuckDuckGo",
	startpage: "Startpage",
	mojeek: "Mojeek",
	ecosia: "Ecosia",
	"google-html": "Google",
	"exa-mcp": "Exa",
	searxng: "SearXNG",
};

const BLOCK_DESCRIPTIONS: Record<SearchBlockReason, string> = {
	challenge: "a bot challenge",
	rate_limited: "a rate limit",
	forbidden: "a refusal",
	network: "a network error",
};

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function extractErrorDetail(payload: unknown, bodyText: string): string {
	if (isJsonObject(payload)) {
		const obj = payload;
		const error = obj.error;
		if (typeof error === "string" && error.length > 0) return truncate(error, MAX_ERROR_DETAIL_LENGTH);
		if (isJsonObject(error)) {
			const message = error.message;
			if (typeof message === "string" && message.length > 0) return truncate(message, MAX_ERROR_DETAIL_LENGTH);
		}
		const message = obj.message;
		if (typeof message === "string" && message.length > 0) return truncate(message, MAX_ERROR_DETAIL_LENGTH);
	}
	const trimmed = bodyText.trim();
	if (!trimmed) return "";
	return truncate(trimmed, MAX_ERROR_DETAIL_LENGTH);
}

function httpErrorMessage(status: number, payload: unknown, bodyText: string): string {
	const detail = extractErrorDetail(payload, bodyText);
	return detail ? `Search failed with HTTP ${status}: ${detail}` : `Search failed with HTTP ${status}`;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function timeoutMsFor(config: SearchProviderEntry): number {
	return Math.max(1, Math.trunc(config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
}

function providerTimeoutMessage(timeoutMs: number): string {
	return `Search timed out after ${timeoutMs}ms`;
}

function searchAbortSignal(
	outerSignal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
	if (outerSignal?.aborted) throw abortReason(outerSignal);

	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort(new DOMException(providerTimeoutMessage(timeoutMs), "TimeoutError"));
	}, timeoutMs);
	const onAbort = () => controller.abort(outerSignal ? abortReason(outerSignal) : undefined);
	outerSignal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			outerSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function noResultsMessage(config: SearchProviderEntry, request: SearchRequest): string {
	return `Search provider ${providerEntryLabel(config)} returned no results for "${request.query}".`;
}

export interface EngineCooldown {
	failures: number;
	until: number;
	reason: SearchBlockReason;
}

export interface SearchRoutingState {
	roundRobinCursor: number;
	successCounts: number[];
	/** Keyed by provider entry label; carried over when the provider list changes so a block outlives it. */
	cooldowns: Map<string, EngineCooldown>;
}

export function createSearchRoutingState(
	providerCount: number,
	cooldowns: Map<string, EngineCooldown> = new Map(),
): SearchRoutingState {
	return { roundRobinCursor: 0, successCounts: Array.from({ length: providerCount }, () => 0), cooldowns };
}

export { providerEntryLabel };

function sortedPriorityIndices(providers: SearchProviderEntry[]): number[] {
	return providers
		.map((provider, index) => ({ index, priority: provider.priority ?? index }))
		.sort((left, right) => left.priority - right.priority || left.index - right.index)
		.map((item) => item.index);
}

function weightedIndices(providers: SearchProviderEntry[]): number[] {
	const indices: number[] = [];
	for (const [index, provider] of providers.entries()) {
		const weight = Math.max(1, Math.trunc(provider.weight ?? 1));
		for (let count = 0; count < weight; count += 1) indices.push(index);
	}
	return indices.length > 0 ? indices : providers.map((_provider, index) => index);
}

function rotateUnique(indices: number[], start: number, providerCount: number): number[] {
	const order: number[] = [];
	for (let offset = 0; offset < indices.length; offset += 1) {
		const index = indices[(start + offset) % indices.length];
		if (index !== undefined && !order.includes(index)) order.push(index);
	}
	for (let index = 0; index < providerCount; index += 1) {
		if (!order.includes(index)) order.push(index);
	}
	return order;
}

function selectOrder(strategy: RoutingStrategy, providers: SearchProviderEntry[], state: SearchRoutingState): number[] {
	if (strategy === "priority") return sortedPriorityIndices(providers);
	if (strategy === "round-robin") {
		const indices = weightedIndices(providers);
		const order = rotateUnique(indices, state.roundRobinCursor % indices.length, providers.length);
		state.roundRobinCursor = (state.roundRobinCursor + 1) % indices.length;
		return order;
	}

	let selected = 0;
	let selectedCount = state.successCounts[0] ?? 0;
	for (let index = 1; index < providers.length; index += 1) {
		const count = state.successCounts[index] ?? 0;
		if (count < selectedCount) {
			selected = index;
			selectedCount = count;
		}
	}
	return [selected, ...providers.map((_provider, index) => index).filter((index) => index !== selected)];
}

function requestInit(built: BuiltSearchRequest, signal: AbortSignal): RequestInit {
	const init: RequestInit = { ...built.init, signal };
	if (built.body !== undefined) init.body = JSON.stringify(built.body);
	else if (built.form !== undefined) init.body = built.form;
	return init;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return {};
	}
}

/** A streamable-HTTP MCP answer is either plain JSON or server-sent events whose `data:` lines carry JSON-RPC. */
function parseEventStream(text: string): unknown {
	if (text.trimStart().startsWith("{")) return parseJson(text);
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const message = parseJson(line.slice(5).trim());
		if (isJsonObject(message) && ("result" in message || "error" in message)) return message;
	}
	return {};
}

function responsePayload(provider: SearchProvider, page: FetchedPage): unknown {
	const parsed = parseProviderBody(provider, page.body);
	if (parsed) return parsed;
	const format = searchResponseFormat(provider);
	if (format === "html") return { html: page.body, url: page.url };
	if (page.body.length === 0) return {};
	return format === "event-stream" ? parseEventStream(page.body) : parseJson(page.body);
}

function retryAfterSeconds(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds);
	const date = Date.parse(header);
	return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function blockForStatus(status: number): SearchBlockReason | undefined {
	if (status === 429) return "rate_limited";
	if (status === 403) return "forbidden";
	return undefined;
}

function engineName(provider: SearchProvider): string {
	return ENGINE_NAMES[provider] ?? provider;
}

async function performProviderSearch(
	config: SearchProviderEntry,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<SearchDetails> {
	const startedAt = Date.now();
	const failure = (error: string, extra: Partial<SearchDetails> = {}): SearchDetails => {
		const details: SearchDetails = {
			provider: config.provider,
			query: request.query,
			results: [],
			durationMs: Date.now() - startedAt,
			truncated: false,
			error,
			...extra,
		};
		if (config.id !== undefined) details.entryId = config.id;
		return details;
	};
	const challengeFailure = (challenge: string) =>
		failure(`${engineName(config.provider)} served a bot challenge (${challenge}) that needs a browser to pass.`, {
			blocked: "challenge",
		});

	const abort = searchAbortSignal(signal, timeoutMsFor(config));
	let response: Response;
	let page: FetchedPage;
	try {
		const prepared = await prepareSearchRequest(config, request, async (built) => {
			const handshake = await fetch(built.url, requestInit(built, abort.signal));
			return { status: handshake.status, url: handshake.url || built.url, body: await handshake.text() };
		});
		if ("challenge" in prepared) return challengeFailure(prepared.challenge);
		response = await fetch(prepared.url, requestInit(prepared, abort.signal));
		page = { status: response.status, url: response.url || prepared.url, body: await response.text() };
	} catch (error) {
		if (signal?.aborted) throw abortReason(signal);
		return failure(error instanceof Error ? error.message : "Search request failed", { blocked: "network" });
	} finally {
		abort.cleanup();
	}

	const challenge = detectSearchChallenge(config.provider, page);
	if (challenge) return challengeFailure(challenge);

	const payload = responsePayload(config.provider, page);
	if (!response.ok) {
		const extra: Partial<SearchDetails> = {};
		const blocked = blockForStatus(response.status);
		const retryAfter = retryAfterSeconds(response);
		if (blocked) extra.blocked = blocked;
		if (retryAfter !== undefined) extra.retryAfterSeconds = retryAfter;
		return failure(httpErrorMessage(response.status, payload, page.body), extra);
	}

	const serviceError = searchResponseError(config.provider, payload);
	if (serviceError) return failure(serviceError);

	const results = await normalizeSearchResponse(config.provider, payload);
	const max = request.maxResults;
	const limitedResults = results.slice(0, max);
	const details: SearchDetails = {
		provider: config.provider,
		query: request.query,
		results: limitedResults,
		durationMs: Date.now() - startedAt,
		truncated: results.length > max,
	};
	if (limitedResults.length === 0) {
		const payloadError =
			isJsonObject(payload) && payload.error !== undefined ? extractErrorDetail({ error: payload.error }, "") : "";
		details.error = payloadError
			? `Search provider ${providerEntryLabel(config)} failed: ${payloadError}`
			: noResultsMessage(config, request);
	}
	if (config.id !== undefined) details.entryId = config.id;
	return details;
}

function attemptFromDetails(details: SearchDetails): SearchAttempt {
	const attempt: SearchAttempt = {
		provider: details.provider,
		durationMs: details.durationMs,
		resultsCount: details.results.length,
	};
	if (details.entryId) attempt.entryId = details.entryId;
	if (details.model) attempt.model = details.model;
	if (details.error) attempt.error = details.error;
	if (details.blocked) attempt.blocked = details.blocked;
	return attempt;
}

function activeCooldown(
	state: SearchRoutingState,
	provider: SearchProviderEntry,
	now: number,
): EngineCooldown | undefined {
	if (!KEYLESS_PROVIDERS.has(provider.provider)) return undefined;
	const cooldown = state.cooldowns.get(providerEntryLabel(provider));
	return cooldown && cooldown.until > now ? cooldown : undefined;
}

function skippedAttempt(provider: SearchProviderEntry, cooldown: EngineCooldown, now: number): SearchAttempt {
	const seconds = Math.ceil((cooldown.until - now) / 1000);
	const attempt: SearchAttempt = {
		provider: provider.provider,
		durationMs: 0,
		resultsCount: 0,
		skipped: true,
		blocked: cooldown.reason,
		error: `skipped (cooling down for ${seconds}s after ${BLOCK_DESCRIPTIONS[cooldown.reason]})`,
	};
	if (provider.id !== undefined) attempt.entryId = provider.id;
	return attempt;
}

/** Exponential backoff per keyless engine: a block starts or doubles its cooldown, a success clears it. */
function recordEngineOutcome(state: SearchRoutingState, provider: SearchProviderEntry, details: SearchDetails): void {
	if (!KEYLESS_PROVIDERS.has(provider.provider)) return;
	const key = providerEntryLabel(provider);
	if (!details.error) {
		state.cooldowns.delete(key);
		return;
	}
	if (!details.blocked) return;
	const failures = (state.cooldowns.get(key)?.failures ?? 0) + 1;
	const backoff = Math.min(ENGINE_COOLDOWN_MAX_MS, ENGINE_COOLDOWN_BASE_MS * 2 ** (failures - 1));
	const requested = Math.min(ENGINE_COOLDOWN_MAX_MS, (details.retryAfterSeconds ?? 0) * 1000);
	state.cooldowns.set(key, { failures, until: Date.now() + Math.max(backoff, requested), reason: details.blocked });
}

export type SearchAttemptListener = (
	providerLabel: string,
	attempts: readonly SearchAttempt[],
	routeLabels: readonly string[],
) => void;

async function searchRoute(
	entry: SearchProviderEntry,
	request: SearchRequest,
	signal: AbortSignal | undefined,
	attempts: SearchAttempt[],
	notify: (label: string) => void,
): Promise<SearchDetails> {
	const searchEntry = async (variant: SearchProviderEntry): Promise<SearchDetails> => {
		notify(providerEntryLabel(variant));
		const result = await performProviderSearch(variant, request, signal);
		if (variant.model !== undefined) result.model = variant.model;
		attempts.push(attemptFromDetails(result));
		return result;
	};
	// A route with a cheaper search model retries on the session model before routing moves on (senpi#2340).
	const [primary, ...retries] = routeAttemptEntries(entry);
	let details = await searchEntry(primary);
	for (const retry of retries) {
		if (!details.error) break;
		details = await searchEntry(retry);
	}
	return details;
}

export async function performSearch(
	config: WebsearchConfig,
	request: SearchRequest,
	signal?: AbortSignal,
	routingState?: SearchRoutingState,
	onAttempt?: SearchAttemptListener,
): Promise<SearchDetails> {
	const startedAt = Date.now();
	const state = routingState ?? createSearchRoutingState(config.providers.length);
	const order = selectOrder(config.strategy, config.providers, state);
	const attempts: SearchAttempt[] = [];
	const routeLabels = order.flatMap((index) => {
		const provider = config.providers[index];
		return provider ? routeAttemptEntries(provider).map(attemptRouteLabel) : [];
	});
	const collected = new Map<string, SearchDetails["results"][number]>();
	let selectedDetails: SearchDetails | undefined;

	for (const index of order) {
		const provider = config.providers[index];
		if (!provider) continue;
		const now = Date.now();
		const cooldown = activeCooldown(state, provider, now);
		if (cooldown) {
			attempts.push(skippedAttempt(provider, cooldown, now));
			if (!config.fallback) break;
			continue;
		}
		const details = await searchRoute(provider, request, signal, attempts, (label) =>
			onAttempt?.(label, attempts, routeLabels),
		);
		recordEngineOutcome(state, provider, details);

		if (details.error) {
			if (!config.fallback) return { ...details, strategy: config.strategy, attempts };
			selectedDetails = details;
			continue;
		}

		state.successCounts[index] = (state.successCounts[index] ?? 0) + 1;

		if (config.strategy !== "fill-first") {
			return { ...details, strategy: config.strategy, attempts };
		}

		selectedDetails = details;
		for (const item of details.results) {
			if (collected.size >= request.maxResults) break;
			collected.set(item.url, item);
		}
		if (collected.size >= request.maxResults) break;
	}

	if (collected.size > 0 && selectedDetails) {
		const results = [...collected.values()];
		const details: SearchDetails = {
			provider: selectedDetails.provider,
			query: request.query,
			results,
			durationMs: Date.now() - startedAt,
			truncated: results.length >= request.maxResults,
			strategy: config.strategy,
			attempts,
		};
		if (selectedDetails.entryId !== undefined) details.entryId = selectedDetails.entryId;
		if (selectedDetails.model !== undefined) details.model = selectedDetails.model;
		return details;
	}

	const failed = selectedDetails ?? {
		provider: config.providers[0]?.provider ?? "exa",
		query: request.query,
		results: [],
		durationMs: Date.now() - startedAt,
		truncated: false,
		error: "All configured search providers failed.",
	};
	return {
		...failed,
		durationMs: Date.now() - startedAt,
		strategy: config.strategy,
		attempts,
		error: `All configured search providers failed: ${attempts.map((attempt) => `${attemptRouteLabel(attempt)} ${attempt.error ?? "failed"}`).join("; ")}`,
	};
}

function attemptOutcome(attempt: SearchAttempt): string {
	if (attempt.skipped) return attempt.error ?? "skipped";
	if (attempt.error) return `${attempt.blocked === "challenge" ? "challenged" : "failed"}: ${attempt.error}`;
	return `${attempt.resultsCount} result${attempt.resultsCount === 1 ? "" : "s"}`;
}

export function formatSearchText(details: SearchDetails): string {
	if (details.error) return details.error;
	if (details.results.length === 0) return `No web search results found for "${details.query}".`;

	const route = ` via ${attemptRouteLabel(details)}`;
	const lines = [`Web search results for "${details.query}"${route}:`, ""];
	if (details.attempts && details.attempts.length > 0) {
		lines.push(
			`Routing attempts: ${details.attempts
				.map((attempt) => `${attemptRouteLabel(attempt)} ${attemptOutcome(attempt)}`)
				.join(" -> ")}`,
			"",
		);
	}
	for (const [index, item] of details.results.entries()) {
		lines.push(`${index + 1}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
	}
	lines.push("", "REMINDER: Include relevant sources from the URLs above in the final answer.");
	return lines.join("\n");
}
