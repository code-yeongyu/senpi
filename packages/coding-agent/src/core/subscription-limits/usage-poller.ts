/**
 * Polls each signed-in subscription account's usage endpoint into the process's limit store (senpi#3684),
 * so `get_subscription_limits`, the `subscription_limits` record and `pi.getSubscriptionLimits()` carry an
 * account's windows before its first turn. Turns keep reporting through the same store (response headers,
 * the Claude SDK `rate_limit_event`); a poll replaces an account's window set, a turn updates windows in it.
 * Every process on the machine shares one cache file, so a machine makes one request per account per
 * interval however many sessions are open.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AuthStorage } from "../auth-storage.ts";
import { type SubscriptionLimitStore, subscriptionLimits } from "./limit-store.ts";
import { listPollAccounts, type PollAccount, SIGN_IN_NEEDED } from "./usage-accounts.ts";
import {
	type CachedReading,
	claimedBy,
	isDue,
	readUsageCache,
	type UsageCacheFile,
	usageKey,
	withClaims,
	withResults,
	writeUsageCache,
} from "./usage-cache.ts";
import { fetchUsageJson, readUsage, type UsageFetch, UsageHttpError, type UsageProvider } from "./usage-endpoints.ts";

/** Claude's numbers move in five-hour blocks and its endpoint is the stricter one, so it is read half as often. */
export const POLL_INTERVAL_MS: Readonly<Record<UsageProvider, number>> = {
	"anthropic-subscription": 300_000,
	"chatgpt-subscription": 150_000,
};
const TICK_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
/** Intervals to wait before asking again about a login only `/login` can fix. */
const SIGNED_OUT_INTERVALS = 5;

export interface UsagePollerDeps {
	readonly store: SubscriptionLimitStore;
	readonly cachePath: string;
	readonly listAccounts: () => Promise<PollAccount[]>;
	readonly fetch: UsageFetch;
	readonly now: () => number;
}

export class UsagePoller {
	readonly #deps: UsagePollerDeps;
	/** The cached reading each account last handed the store, so an unchanged reading is not re-announced. */
	readonly #adopted = new Map<string, number>();
	#running = false;

	constructor(deps: UsagePollerDeps) {
		this.#deps = deps;
	}

	/** One pass: adopt what siblings already read, fetch what is due and claimed by this process, publish. */
	async pollOnce(signal: AbortSignal = new AbortController().signal): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		try {
			const accounts = new Map((await this.#deps.listAccounts()).map((account) => [keyOf(account), account]));
			const path = this.#deps.cachePath;
			const before = readUsageCache(path);
			this.#adopt(before, accounts);
			const now = this.#deps.now();
			const due = [...accounts.keys()].filter((key) => isDue(before, key, now));
			if (due.length === 0) return;
			const token = randomUUID();
			writeUsageCache(path, withClaims(before, due, now, token));
			const owned = claimedBy(readUsageCache(path), due, token);
			const results = new Map<string, CachedReading>();
			await Promise.all(
				owned.flatMap((key) => {
					const account = accounts.get(key);
					if (account === undefined) return [];
					return [this.#read(account, before.accounts[key], signal).then((reading) => results.set(key, reading))];
				}),
			);
			const after = withResults(readUsageCache(path), results, token);
			writeUsageCache(path, after);
			this.#adopt(after, accounts);
		} finally {
			this.#running = false;
		}
	}

	#adopt(cache: UsageCacheFile, accounts: ReadonlyMap<string, PollAccount>): void {
		for (const [key, account] of accounts) {
			const reading = cache.accounts[key];
			if (reading === undefined || this.#adopted.get(key) === reading.updatedAt) continue;
			this.#adopted.set(key, reading.updatedAt);
			const reportedAt = new Date(reading.updatedAt);
			this.#deps.store.report(
				account.provider,
				account.account,
				reading.error !== undefined
					? { error: reading.error, reportedAt }
					: {
							windows: reading.windows,
							...(reading.plan === undefined ? {} : { plan: reading.plan }),
							reportedAt,
						},
			);
		}
	}

	async #read(account: PollAccount, previous: CachedReading | undefined, signal: AbortSignal): Promise<CachedReading> {
		const interval = POLL_INTERVAL_MS[account.provider];
		const now = this.#deps.now();
		const credential = await account.access(signal);
		if (credential === undefined) {
			// Nothing to ask with yet: keep what is known and look again next interval.
			return { ...(previous ?? { windows: [], updatedAt: now }), nextAt: now + interval };
		}
		if ("error" in credential) {
			return { windows: [], error: credential.error, updatedAt: now, nextAt: now + SIGNED_OUT_INTERVALS * interval };
		}
		try {
			const reading = await readUsage(account.provider, credential.access, this.#deps.fetch);
			return { ...reading, updatedAt: now, nextAt: now + interval };
		} catch (error) {
			const failure = describeFailure(error, interval);
			return {
				windows: [],
				error: failure.error,
				updatedAt: now,
				nextAt: now + Math.min(failure.waitMs, MAX_BACKOFF_MS),
			};
		}
	}
}

function keyOf(account: PollAccount): string {
	return usageKey(account.provider, account.account);
}

/** A 429 with `retry-after: 0` means the window is about to roll, so only a positive header earns a long wait. */
function describeFailure(error: unknown, interval: number): { error: string; waitMs: number } {
	if (error instanceof UsageHttpError) {
		if (error.status === 401 || error.status === 403)
			return { error: SIGN_IN_NEEDED, waitMs: SIGNED_OUT_INTERVALS * interval };
		if (error.status === 429) return { error: "rate limited", waitMs: error.retryAfterMs ?? interval };
		return { error: `HTTP ${error.status}`, waitMs: error.retryAfterMs ?? 2 * interval };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { error: /abort|timeout|timed out/i.test(message) ? "timed out" : "unreachable", waitMs: 2 * interval };
}

let running: { stop(): void } | undefined;

/**
 * Starts the process's poller once (interactive and RPC modes; never print mode or `--offline`). The timer
 * is unref'd, so it never holds the process open; `report` receives a pass that failed as a whole.
 */
export function startSubscriptionUsagePolling(options: {
	readonly agentDir: string;
	readonly report: (message: string) => void;
}): { stop(): void } {
	if (running !== undefined) return running;
	const storage = AuthStorage.create(join(options.agentDir, "auth.json"));
	const poller = new UsagePoller({
		store: subscriptionLimits,
		cachePath: join(options.agentDir, "subscription-usage.json"),
		listAccounts: () =>
			listPollAccounts({
				store: storage,
				env: (name) => process.env[name],
				now: Date.now,
			}),
		fetch: fetchUsageJson,
		now: Date.now,
	});
	const controller = new AbortController();
	const tick = () =>
		void poller.pollOnce(controller.signal).catch((error: unknown) => {
			options.report(`senpi subscription limits: usage poll failed: ${String(error)}`);
		});
	tick();
	const timer = setInterval(tick, TICK_MS);
	timer.unref();
	running = {
		stop() {
			controller.abort();
			clearInterval(timer);
			running = undefined;
		},
	};
	return running;
}
