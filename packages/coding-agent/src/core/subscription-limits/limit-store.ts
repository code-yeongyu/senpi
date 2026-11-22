/**
 * The latest limit windows each subscription account reported, kept for the life of the process and
 * shared by every session on it (one account's windows are the same whichever session asked). An account
 * is named by its credential slot - the stored account's name, `env` for an environment key, `default`
 * for a single credential - never by key material. Nothing reported yet means the account is absent.
 */
import type { StreamOptions } from "@earendil-works/pi-ai";
import type { LimitWindow } from "./limit-windows.ts";
import { claudeWindowsFromHeaders, codexWindowsFromHeaders } from "./limit-windows.ts";

export interface AccountLimits {
	readonly provider: string;
	readonly account: string;
	readonly windows: readonly LimitWindow[];
	/** ISO time of the response that reported them. */
	readonly reportedAt: string;
	/** The plan the provider's usage endpoint names (`pro`, `max`, ...), when it names one. */
	readonly plan?: string;
	/**
	 * Why the last usage poll for this account failed (`sign-in needed`, `rate limited`, ...). The windows
	 * beside it are the last ones reported; the next successful report clears it (senpi#3684).
	 */
	readonly error?: string;
}

/**
 * A record as the stores of one process's isolates mirror it to each other (senpi#3695). `updatedAt` is when the
 * record last really changed, set only when that differs from `reportedAt` (a failed poll adds an error beside the
 * last windows, which keep their time). With `revision` it orders mirrored copies; neither leaves the mirror:
 * `snapshot()` and `subscribe()` hand out the public shape.
 */
export interface MirroredLimits extends AccountLimits {
	readonly updatedAt?: string;
	/**
	 * How many local writes landed at the same `updatedAt ?? reportedAt` instant before this one, so a same-instant
	 * write still orders after the record it replaces. Absent means 0. The time stays the real change time.
	 */
	readonly revision?: number;
}

/** What one usage-endpoint poll learned about an account: its full window set, or why it could not ask. */
export type PollReport =
	| { readonly windows: readonly LimitWindow[]; readonly plan?: string; readonly reportedAt: Date }
	| { readonly error: string; readonly reportedAt: Date };

type Listener = (limits: AccountLimits) => void;
type MirrorListener = (limits: MirroredLimits) => void;

export class SubscriptionLimitStore {
	readonly #accounts = new Map<string, MirroredLimits>();
	readonly #listeners = new Set<Listener>();
	readonly #mirrorListeners = new Set<MirrorListener>();

	/** Keeps the windows one response reported; a window it did not mention keeps its last value. */
	record(provider: string, account: string, windows: readonly LimitWindow[], now = new Date()): void {
		if (windows.length === 0) return;
		const key = `${provider}\u0000${account}`;
		const previous = this.#accounts.get(key);
		const merged = new Map((previous?.windows ?? []).map((window) => [window.id, window]));
		for (const window of windows) merged.set(window.id, window);
		this.#write(key, previous, {
			provider,
			account,
			windows: [...merged.values()],
			reportedAt: now.toISOString(),
			...(previous?.plan === undefined ? {} : { plan: previous.plan }),
		});
	}

	/**
	 * Keeps what a usage-endpoint poll learned (senpi#3684). The endpoint answers with the account's whole
	 * window set, so it replaces the windows rather than merging; a failed poll keeps the last windows and
	 * says why beside them. An account with no windows and no prior record stays absent on success. A
	 * reading older than what the store already holds (a sibling's cached poll adopted after a fresher turn)
	 * is ignored, so the shown usage never goes backwards.
	 */
	report(provider: string, account: string, report: PollReport): void {
		const key = `${provider}\u0000${account}`;
		const previous = this.#accounts.get(key);
		const reportedAt = report.reportedAt.toISOString();
		if (previous !== undefined && reportedAt < changedAtOf(previous)) return;
		if ("error" in report) {
			if (previous?.error === report.error) return;
			const {
				updatedAt: _changedAt,
				revision: _revision,
				...base
			} = previous ?? {
				provider,
				account,
				windows: [],
				reportedAt,
			};
			this.#write(key, previous, { ...base, error: report.error }, reportedAt);
			return;
		}
		if (report.windows.length === 0 && previous === undefined) return;
		this.#write(key, previous, {
			provider,
			account,
			windows: [...report.windows],
			reportedAt,
			...(report.plan === undefined ? {} : { plan: report.plan }),
		});
	}

	/**
	 * Takes another isolate's record as it stands (senpi#3695: the host and its session workers each hold a store
	 * and mirror each other). It goes through the same total order as every local write, so whatever order the
	 * copies cross in, every store keeps the same record and the echo ends when a copy comes straight back.
	 */
	adopt(limits: MirroredLimits): void {
		this.#offer(`${limits.provider}\u0000${limits.account}`, limits);
	}

	/**
	 * A write from this store's own turn or poll always lands: it orders strictly after the held record. A later
	 * `changedAt` does that by time; at the same instant (or a clock that reads earlier) the time stays the held
	 * record's real change time and `revision` counts up, so a mirrored store takes it by the same total order.
	 */
	#write(
		key: string,
		previous: MirroredLimits | undefined,
		limits: AccountLimits,
		changedAt = limits.reportedAt,
	): void {
		const held = previous === undefined ? undefined : changedAtOf(previous);
		const later = held === undefined || changedAt > held;
		const time = later ? changedAt : held;
		const revision = later ? 0 : (previous?.revision ?? 0) + 1;
		this.#publish(key, {
			...limits,
			...(time === limits.reportedAt ? {} : { updatedAt: time }),
			...(revision === 0 ? {} : { revision }),
		});
	}

	/**
	 * The mirror's rule (senpi#3695): a copy replaces the held record only when it is strictly later in the total
	 * order (change time, then revision, then content), so two stores that see the same records keep the same one.
	 */
	#offer(key: string, limits: MirroredLimits): void {
		const previous = this.#accounts.get(key);
		if (previous === undefined) {
			this.#publish(key, limits);
			return;
		}
		// Two isolates that each wrote locally from the same held record at the same instant carry the same stamp.
		// Neither update may be lost, so the two are combined symmetrically: both stores reach the same record.
		if (canonical(limits) === canonical(previous)) return;
		if (changedAtOf(limits) === changedAtOf(previous) && (limits.revision ?? 0) === (previous.revision ?? 0)) {
			const combined = combineConcurrent(previous, limits);
			if (canonical(combined) !== canonical(previous)) this.#publish(key, combined);
			return;
		}
		if (compareRecords(limits, previous) <= 0) return;
		this.#publish(key, limits);
	}

	#publish(key: string, limits: MirroredLimits): void {
		this.#accounts.set(key, limits);
		// A listener (a client broadcast or the isolate mirror) failing must never reach the provider response this
		// runs inside, so each failure is reported and contained here.
		const shown = publicShape(limits);
		const calls: (() => void)[] = [
			...[...this.#mirrorListeners].map((listener) => () => listener(limits)),
			...[...this.#listeners].map((listener) => () => listener(shown)),
		];
		for (const call of calls) {
			try {
				call();
			} catch (error) {
				process.stderr.write(`senpi subscription limits: a listener failed: ${String(error)}\n`);
			}
		}
	}

	snapshot(): readonly AccountLimits[] {
		return [...this.#accounts.values()].map(publicShape);
	}

	/** The records with their ordering key, for mirroring into another isolate's store. */
	mirrorSnapshot(): readonly MirroredLimits[] {
		return [...this.#accounts.values()];
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Hears every change with its ordering key, for mirroring into another isolate's store. */
	subscribeMirror(listener: MirrorListener): () => void {
		this.#mirrorListeners.add(listener);
		return () => this.#mirrorListeners.delete(listener);
	}
}

/** When the record last really changed: never bumped, so a poll compares against a real time. */
function changedAtOf(limits: MirroredLimits): string {
	return limits.updatedAt ?? limits.reportedAt;
}

/** The total order every store applies: change time, then revision, then key-sorted content. */
function compareRecords(a: MirroredLimits, b: MirroredLimits): number {
	const [first, second] = [changedAtOf(a), changedAtOf(b)];
	if (first !== second) return first < second ? -1 : 1;
	const [firstRevision, secondRevision] = [a.revision ?? 0, b.revision ?? 0];
	if (firstRevision !== secondRevision) return firstRevision < secondRevision ? -1 : 1;
	const [left, right] = [canonical(a), canonical(b)];
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Combines two different records that changed at the same stamp (senpi#3695). Symmetric, so both isolates land on
 * the same record.
 *
 * Windows and plan come from the side whose `reportedAt` is later: that is when its windows were really reported
 * (an error keeps the previous windows and their `reportedAt`, so a poll that reset usage or dropped a window wins
 * over the other side's older copy). Only when `reportedAt` also ties are the windows the union by id (on the same
 * id the window that sorts later wins), and the plan the value that sorts later.
 *
 * The error is kept when either side set it (the value that sorts later when both did): a success at the same stamp
 * does not clear the other side's error. The next poll clears it, so the cost is one poll interval of a stale notice
 * beside current windows.
 */
function combineConcurrent(a: MirroredLimits, b: MirroredLimits): MirroredLimits {
	const later = <T>(x: T | undefined, y: T | undefined): T | undefined =>
		x === undefined ? y : y === undefined ? x : canonical(x) >= canonical(y) ? x : y;
	if (a.reportedAt !== b.reportedAt) {
		const newer = a.reportedAt < b.reportedAt ? b : a;
		return concurrentRecord(a, newer.windows, newer.plan, later(a.error, b.error), newer.reportedAt);
	}
	const windows = new Map(a.windows.map((window) => [window.id, window]));
	for (const window of b.windows) windows.set(window.id, later(windows.get(window.id), window) ?? window);
	return concurrentRecord(a, [...windows.values()], later(a.plan, b.plan), later(a.error, b.error), a.reportedAt);
}

/** The combined record at `a`'s stamp (both sides share it), reported at the later `reportedAt` of the two. */
function concurrentRecord(
	a: MirroredLimits,
	windows: readonly MirroredLimits["windows"][number][],
	plan: string | undefined,
	error: string | undefined,
	reportedAt: string,
): MirroredLimits {
	const updatedAt = changedAtOf(a);
	return {
		provider: a.provider,
		account: a.account,
		windows: [...windows].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
		reportedAt,
		...(plan === undefined ? {} : { plan }),
		...(error === undefined ? {} : { error }),
		...(updatedAt === reportedAt ? {} : { updatedAt }),
		...(a.revision === undefined || a.revision === 0 ? {} : { revision: a.revision }),
	};
}

function publicShape({ updatedAt: _changedAt, revision: _revision, ...limits }: MirroredLimits): AccountLimits {
	return limits;
}

/** A key-order-independent rendering of a record, so equal records compare equal however they were built. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		field !== null && typeof field === "object" && !Array.isArray(field)
			? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: field,
	);
}

/** The process's store. */
export const subscriptionLimits = new SubscriptionLimitStore();

/** The account a request ran under, as the store names it. */
export function limitAccountOf(slotAuth: { apiKey?: string; slotName?: string } | undefined): string {
	if (slotAuth?.slotName !== undefined) return slotAuth.slotName;
	return slotAuth?.apiKey !== undefined ? "env" : "default";
}

/** Request options whose `onResponse` also records the windows the response headers carry. */
export function withLimitCapture<TOptions extends Pick<StreamOptions, "onResponse">>(
	options: TOptions,
	provider: string,
	account: string,
	store: SubscriptionLimitStore = subscriptionLimits,
): TOptions {
	const inner = options.onResponse;
	const onResponse: NonNullable<StreamOptions["onResponse"]> = (response, model) => {
		store.record(provider, account, [
			...codexWindowsFromHeaders(response.headers),
			...claudeWindowsFromHeaders(response.headers),
		]);
		return inner?.(response, model);
	};
	return { ...options, onResponse };
}
