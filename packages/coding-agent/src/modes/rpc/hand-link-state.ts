/**
 * What the `hand_link` endpoint must remember across a daemon restart, in one locked durable store
 * (`locked-file-store.ts`) on one admission line:
 * - the hand's epoch floors (`createHandEpochFence`);
 * - each hosted session's record: the lowest generation it may still open, the owner and loop admitted at that
 *   generation, which daemon opened that link and whether it ended cleanly, and whether the session closed for good;
 * - which session each scope belongs to.
 *
 * Ownership: `verifyOwner()` reads the store's owner file, a single small read, and the endpoint calls it before every
 * batch; the store's watch is the proactive path that stops live links between batches. Once another daemon owns the
 * store, `owned()` is false for good and the fence refuses every call, whatever its in-memory floors say.
 *
 * Bounds: a session holds at most `maxScopes` scopes, and at most `maxSessions` sessions hold a live link. At open
 * (when no link can belong to this daemon yet), a record last written more than `retentionMs` ago is compacted: its
 * holder, scope bindings and their floors go, and the record itself stays as a tombstone of `{ lowest, at, closed? }`,
 * so a closed session stays closed and an old generation stays refused for as long as the state file exists.
 * A record that does not decode fails closed: opening the state throws.
 */
import { join } from "node:path";
import {
	createAdmissionLine,
	createHandEpochFence,
	EPOCH_FLOOR_PREFIX,
	type HandEpochFence,
} from "@earendil-works/pi-agent-core";
import type { StoreValue, StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import type { LockedFileStore } from "./locked-file-store.ts";

const SESSION_PREFIX = "hand-link.session:";
const SCOPE_PREFIX = "hand-link.scope:";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Where the endpoint keeps its state: `<agentDir>/rpc/hand-link/state.json`. */
export function handLinkStatePath(agentDir: string): string {
	return join(agentDir, "rpc", "hand-link", "state.json");
}

export interface Holder {
	readonly owner: string;
	readonly loopId: string;
	/** The daemon that opened this link; `ended` once that daemon ended it with its calls settled. */
	readonly daemon: string;
	readonly ended?: true;
}

export interface SessionRecord {
	readonly lowest: number;
	readonly holder?: Holder;
	readonly closed?: true;
	/** When the record was last written (ms since the epoch). */
	readonly at: number;
}

export interface HandLinkStateOptions {
	readonly now?: () => number;
	/** How long a record keeps its holder and scopes before it is compacted; default seven days. */
	readonly retentionMs?: number;
	/** The most scopes one session may hold; default 64. */
	readonly maxScopes?: number;
	/** The most sessions that may hold a live link at once; default 256. */
	readonly maxSessions?: number;
}

export type ScopeClaim = "held" | "taken" | "limit";

export interface HandLinkState {
	readonly fence: HandEpochFence;
	/** Whether this daemon still owns the store, as last seen; `false` for good once another daemon claimed it. */
	owned(): boolean;
	/** Reads the owner on disk: `false` (and superseded for good) when another daemon owns the store. */
	verifyOwner(): Promise<boolean>;
	/** Calls `listener` once, when this daemon learns another one owns the store. */
	onSuperseded(listener: () => void): void;
	session(session: string): SessionRecord | undefined;
	/** Whether opening a link for `session` would pass the live-session cap. */
	hasRoomFor(session: string): boolean;
	/** Records `owner`'s `loopId` as the session's link at `generation`, opened by this daemon. */
	admit(session: string, generation: number, holder: Pick<Holder, "owner" | "loopId">): Promise<void>;
	/** Ends the session's link: nothing is held and only `lowest` or above may open it again. */
	end(session: string, lowest: number): Promise<void>;
	/** Marks the links this daemon opened for `sessions` as ended cleanly, so a successor may reopen them in place. */
	release(sessions: readonly string[]): Promise<void>;
	/** Closes the session for good: its scopes and their floors go, and a tombstone refuses every later batch. */
	retire(session: string): Promise<void>;
	/** Binds `scope` to `session`: `taken` when another session holds it, `limit` past the session's scope cap. */
	claim(scope: string, session: string): Promise<ScopeClaim>;
	/** Stops watching the store's owner. */
	close(): void;
}

const isCount = (value: unknown, minimum: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const isLive = (record: SessionRecord | undefined): boolean =>
	record?.holder !== undefined && record.holder.ended !== true && record.closed !== true;

class HandLinkStateCorruptError extends Error {
	constructor(key: string, reason: string) {
		super(`hand_link state: ${key} ${reason}`);
		this.name = "HandLinkStateCorruptError";
	}
}

function decodeSession(key: string, data: StoreValue): SessionRecord {
	const field = (name: string): unknown =>
		typeof data === "object" && data !== null && !Array.isArray(data) ? Reflect.get(data, name) : undefined;
	const [lowest, at, closed] = [field("lowest"), field("at"), field("closed")];
	const [owner, loopId, daemon, ended] = [field("owner"), field("loopId"), field("daemon"), field("ended")];
	if (!isCount(lowest, 1)) throw new HandLinkStateCorruptError(key, "has no lowest generation of at least 1");
	if (!isCount(at, 0)) throw new HandLinkStateCorruptError(key, "has no write time");
	if (closed !== undefined && closed !== true) throw new HandLinkStateCorruptError(key, "has a malformed closed mark");
	const marks = closed === true ? { closed: true as const } : {};
	if (owner === undefined && loopId === undefined && daemon === undefined) return { lowest, at, ...marks };
	if (typeof owner !== "string" || typeof loopId !== "string" || typeof daemon !== "string")
		throw new HandLinkStateCorruptError(key, "has a malformed holder");
	if (ended !== undefined && ended !== true) throw new HandLinkStateCorruptError(key, "has a malformed ended mark");
	const holder: Holder = { owner, loopId, daemon, ...(ended === true ? { ended } : {}) };
	return { lowest, at, holder, ...marks };
}

/** Claims `store` for `token` (this daemon), compacts expired records, and loads what an earlier process left in it. */
export async function openHandLinkState(
	store: LockedFileStore,
	token: string,
	options: HandLinkStateOptions = {},
): Promise<HandLinkState> {
	const now = options.now ?? Date.now;
	const retentionMs = options.retentionMs ?? 7 * DAY_MS;
	const maxScopes = options.maxScopes ?? 64;
	const maxSessions = options.maxSessions ?? 256;
	const epoch = await store.claimFor(token);
	let owned = true;
	const supersededListeners: Array<() => void> = [];
	const lose = (): void => {
		if (!owned) return;
		owned = false;
		for (const listener of supersededListeners.splice(0)) listener();
	};
	// Started right after the claim and measured against this daemon's own token, so a claim made while the rest of
	// the state loads is still seen.
	const stopWatching = store.watchOwnership(token, lose);
	const admission = createAdmissionLine();
	const sessions = new Map<string, SessionRecord>();
	const scopes = new Map<string, string>();
	for (const { key, data } of await store.scanDocuments(SESSION_PREFIX))
		sessions.set(key.slice(SESSION_PREFIX.length), decodeSession(key, data));
	for (const { key, data } of await store.scanDocuments(SCOPE_PREFIX)) {
		if (typeof data !== "string") throw new HandLinkStateCorruptError(key, "does not name a session");
		scopes.set(key.slice(SCOPE_PREFIX.length), data);
	}
	const commit = (writes: readonly StoreWrite[], adopt: () => void): Promise<void> =>
		admission.admit(async () => {
			await store.commit(epoch, writes, adopt);
		});
	const scopesOf = (session: string): string[] =>
		[...scopes].flatMap(([scope, holder]) => (holder === session ? [scope] : []));
	const dropScopes = (held: readonly string[]): StoreWrite[] =>
		held.flatMap((scope): StoreWrite[] => [
			{ op: "delete", key: `${SCOPE_PREFIX}${scope}` },
			{ op: "delete", key: `${EPOCH_FLOOR_PREFIX}${scope}` },
		]);
	const sessionWrite = (session: string, record: SessionRecord): StoreWrite => ({
		op: "put",
		key: `${SESSION_PREFIX}${session}`,
		data: { lowest: record.lowest, at: record.at, ...record.holder, ...(record.closed ? { closed: true } : {}) },
	});
	// A compacted record keeps only what refuses later batches: an open holder's generation can never reopen.
	const compacted = (record: SessionRecord): SessionRecord => ({
		lowest: isLive(record) ? record.lowest + 1 : record.lowest,
		at: record.at,
		...(record.closed ? { closed: true as const } : {}),
	});

	const expired = [...sessions].flatMap(([session, record]) =>
		now() - record.at > retentionMs && (record.holder !== undefined || scopesOf(session).length > 0)
			? [[session, compacted(record)] as const]
			: [],
	);
	if (expired.length > 0) {
		const held = expired.flatMap(([session]) => scopesOf(session));
		const writes = [...expired.map(([session, record]) => sessionWrite(session, record)), ...dropScopes(held)];
		await commit(writes, () => {
			for (const [session, record] of expired) sessions.set(session, record);
			for (const scope of held) scopes.delete(scope);
		});
	}

	const floors = createHandEpochFence({
		ownerOf: (scope) => {
			const session = scopes.get(scope);
			return session === undefined ? undefined : sessions.get(session)?.holder?.owner;
		},
		durable: { store, epoch, admission },
	});
	await floors.ready;
	// Its in-memory floors stop meaning anything once another daemon owns the store: then it admits and raises nothing.
	const fence: HandEpochFence = {
		ready: floors.ready,
		admits: (scope, at, sender) => owned && floors.admits(scope, at, sender),
		raise: (scope, at, sender) =>
			owned ? floors.raise(scope, at, sender) : Promise.resolve({ kind: "refused", reason: "peer_unauthorized" }),
	};

	const putSession = (session: string, record: SessionRecord): Promise<void> =>
		commit([sessionWrite(session, record)], () => sessions.set(session, record));
	return {
		fence,
		owned: () => owned,
		async verifyOwner() {
			if (owned && (await store.owner()) !== token) lose();
			return owned;
		},
		onSuperseded(listener) {
			if (owned) supersededListeners.push(listener);
			else listener();
		},
		session: (session) => sessions.get(session),
		hasRoomFor: (session) =>
			isLive(sessions.get(session)) || [...sessions.values()].filter(isLive).length < maxSessions,
		admit: (session, generation, holder) =>
			putSession(session, { lowest: generation, at: now(), holder: { ...holder, daemon: token } }),
		end: (session, lowest) => putSession(session, { lowest, at: now() }),
		async release(released) {
			const writes = released.flatMap((session): Array<[string, SessionRecord]> => {
				const record = sessions.get(session);
				if (record?.holder === undefined || record.holder.daemon !== token) return [];
				return [[session, { ...record, at: now(), holder: { ...record.holder, ended: true } }]];
			});
			if (writes.length === 0) return;
			await commit(
				writes.map(([session, record]) => sessionWrite(session, record)),
				() => {
					for (const [session, record] of writes) sessions.set(session, record);
				},
			);
		},
		async retire(session) {
			const held = scopesOf(session);
			const tombstone: SessionRecord = { lowest: sessions.get(session)?.lowest ?? 1, at: now(), closed: true };
			await commit([sessionWrite(session, tombstone), ...dropScopes(held)], () => {
				sessions.set(session, tombstone);
				for (const scope of held) scopes.delete(scope);
			});
		},
		async claim(scope, session) {
			const holder = scopes.get(scope);
			if (holder !== undefined) return holder === session ? "held" : "taken";
			if (scopesOf(session).length >= maxScopes) return "limit";
			await commit([{ op: "put", key: `${SCOPE_PREFIX}${scope}`, data: session }], () => scopes.set(scope, session));
			return "held";
		},
		close: stopWatching,
	};
}
