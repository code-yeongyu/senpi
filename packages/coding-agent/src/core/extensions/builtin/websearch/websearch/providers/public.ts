import type {
	BuiltSearchRequest,
	SearchDetails,
	SearchProvider,
	SearchProviderEntry,
	SearchRequest,
	SearchResultItem,
} from "../types.ts";
import type { ProviderModule } from "./shared.ts";

/**
 * The keyless HTML engines `public` fans out to, in tiebreak order: when two URLs have the same engine count and
 * best rank, the one an earlier engine returned first wins. Google-index engines lead and Mojeek's independent
 * index breaks the remaining ties (ported from oh-my-pi's Public Web aggregate).
 */
export const PUBLIC_ENGINES = [
	"startpage",
	"google-html",
	"duckduckgo-html",
	"ecosia",
	"mojeek",
] as const satisfies readonly SearchProvider[];

export const PUBLIC_SOFT_DEADLINE_MS = 5_000;
export const PUBLIC_HARD_DEADLINE_MS = 30_000;

export type PublicEngineSearch = (
	entry: SearchProviderEntry,
	request: SearchRequest,
	signal: AbortSignal,
) => Promise<SearchDetails>;

export type PublicDeadlineWait = (ms: number, signal: AbortSignal) => Promise<void>;

interface MergedResult {
	item: SearchResultItem;
	engines: number;
	bestRank: number;
	order: number;
}

function timerWait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/**
 * Canonical dedupe key: lower-case host without a leading `www.`, path without a trailing slash, query kept,
 * fragment dropped. Engines disagree on exactly these variations for the same page.
 */
export function publicDedupeKey(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	return `${host}${path}${url.search}`;
}

function mergeResults(merged: Map<string, MergedResult>, results: readonly SearchResultItem[]): void {
	for (const [rank, item] of results.entries()) {
		const key = publicDedupeKey(item.url);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { item: { ...item }, engines: 1, bestRank: rank, order: merged.size });
			continue;
		}
		existing.engines += 1;
		if (rank < existing.bestRank) {
			existing.bestRank = rank;
			existing.item.title = item.title;
			existing.item.url = item.url;
		}
		if (item.snippet && item.snippet.length > (existing.item.snippet?.length ?? 0)) {
			existing.item.snippet = item.snippet;
		}
		existing.item.publishedAt ??= item.publishedAt;
	}
}

function engineEntry(entry: SearchProviderEntry, provider: SearchProvider): SearchProviderEntry {
	const engine: SearchProviderEntry = { provider };
	if (entry.timeoutMs !== undefined) engine.timeoutMs = entry.timeoutMs;
	if (entry.allowedDomains) engine.allowedDomains = entry.allowedDomains;
	if (entry.blockedDomains) engine.blockedDomains = entry.blockedDomains;
	return engine;
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Searches every keyless engine at once and merges the answers: URLs are deduplicated on `publicDedupeKey`, ranked
 * by how many engines returned them and then by their best per-engine rank, and each keeps its longest snippet.
 *
 * Returns at the earliest of: every engine settled; the soft deadline passed with at least one engine answered;
 * the hard deadline. Engines still running then are aborted. A failed engine is tolerated; the call fails only
 * when no engine answered.
 */
export async function searchPublicWeb(
	entry: SearchProviderEntry,
	request: SearchRequest,
	signal: AbortSignal | undefined,
	searchEngine: PublicEngineSearch,
	wait: PublicDeadlineWait = timerWait,
): Promise<SearchDetails> {
	if (signal?.aborted) throw abortReason(signal);
	const startedAt = Date.now();
	// A count chosen for this call outranks the entry's own value, the same rule every other provider follows.
	const maxResults = request.maxResultsFromCall ? request.maxResults : (entry.maxResults ?? request.maxResults);
	const engineRequest: SearchRequest = { ...request, maxResults };

	const stragglers = new AbortController();
	const onAbort = () => stragglers.abort(signal ? abortReason(signal) : undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	const timers = new AbortController();

	const answers: Array<SearchDetails | undefined> = PUBLIC_ENGINES.map(() => undefined);
	const failures: Array<string | undefined> = PUBLIC_ENGINES.map(() => undefined);
	let answered = 0;
	let failed = 0;
	let markFirstAnswer = () => {};
	const firstAnswer = new Promise<void>((resolve) => {
		markFirstAnswer = resolve;
	});
	const all = Promise.all(
		PUBLIC_ENGINES.map(async (provider, index) => {
			try {
				const details = await searchEngine(engineEntry(entry, provider), engineRequest, stragglers.signal);
				if (details.error) {
					failures[index] = details.error;
					failed += 1;
					return;
				}
				answers[index] = details;
				answered += 1;
				markFirstAnswer();
			} catch (error) {
				failures[index] = error instanceof Error ? error.message : String(error);
				failed += 1;
			}
		}),
	);

	let settledAnswers: Array<SearchDetails | undefined>;
	let settledFailures: Array<string | undefined>;
	try {
		await Promise.race([all, wait(PUBLIC_SOFT_DEADLINE_MS, timers.signal)]);
		if (answered === 0 && failed < PUBLIC_ENGINES.length) {
			await Promise.race([all, firstAnswer, wait(PUBLIC_HARD_DEADLINE_MS - PUBLIC_SOFT_DEADLINE_MS, timers.signal)]);
		}
		// Snapshot before aborting: an engine that settles after this point does not count.
		settledAnswers = [...answers];
		settledFailures = [...failures];
	} finally {
		timers.abort();
		signal?.removeEventListener("abort", onAbort);
		stragglers.abort(new DOMException("The public search already answered.", "AbortError"));
	}
	if (signal?.aborted) throw abortReason(signal);

	// Merge in engine order, not settlement order, so ties break the same way every time.
	const merged = new Map<string, MergedResult>();
	for (const details of settledAnswers) {
		if (details) mergeResults(merged, details.results);
	}
	const durationMs = Date.now() - startedAt;
	const base: SearchDetails = { provider: "public", query: request.query, results: [], durationMs, truncated: false };
	if (entry.id !== undefined) base.entryId = entry.id;

	if (merged.size === 0) {
		const reasons = PUBLIC_ENGINES.map((provider, index) => {
			const reason = settledFailures[index] ?? `no answer within ${durationMs}ms`;
			return `${provider}: ${reason}`;
		});
		return { ...base, error: `Search provider public failed: every engine failed (${reasons.join("; ")})` };
	}

	const ranked = [...merged.values()].sort(
		(left, right) => right.engines - left.engines || left.bestRank - right.bestRank || left.order - right.order,
	);
	return {
		...base,
		results: ranked.slice(0, maxResults).map((entry) => entry.item),
		truncated: ranked.length > maxResults,
	};
}

/** `public` sends no request of its own; `performProviderSearch` routes it to `searchPublicWeb`. */
export const publicProvider: ProviderModule = {
	buildRequest(): BuiltSearchRequest {
		throw new Error("Provider public has no request of its own: it fans out to the keyless engines.");
	},
};
