/**
 * What the `hand_link` endpoint must remember across a daemon restart, in one locked durable store
 * (`locked-file-store.ts`) on one admission line:
 * - the hand's epoch floors (`createHandEpochFence`);
 * - each hosted session's link record: the lowest generation it may still open, the owner and loop admitted at that
 *   generation, and whether the session closed for good;
 * - which session each scope belongs to.
 *
 * A restarted daemon acks a session's floor at the generation it reached and still refuses an older generation or a
 * second sender at that one. Only the store's owner writes, and every batch first checks that this daemon still owns it
 * (`owned`), so the in-memory view is the file's. A record that does not decode fails closed: opening the state throws.
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

/** Where the endpoint keeps its state: `<agentDir>/rpc/hand-link/state.json`. */
export function handLinkStatePath(agentDir: string): string {
	return join(agentDir, "rpc", "hand-link", "state.json");
}

/** A session's link record: the lowest generation it may open, who holds the one admitted last, and whether it closed. */
export interface SessionRecord {
	readonly lowest: number;
	readonly holder?: { readonly owner: string; readonly loopId: string };
	readonly closed?: true;
}

export interface HandLinkState {
	readonly fence: HandEpochFence;
	/** Whether this daemon still owns the store on disk; a newer daemon's claim supersedes it. */
	owned(): Promise<boolean>;
	session(session: string): SessionRecord | undefined;
	/** Records `owner`'s `loopId` as the session's link at `generation`. */
	admit(session: string, generation: number, holder: NonNullable<SessionRecord["holder"]>): Promise<void>;
	/** Ends the session's link: nothing is held and only `lowest` or above may open it again. */
	end(session: string, lowest: number): Promise<void>;
	/** Closes the session for good: its scopes and their floors go, and a tombstone refuses every later batch. */
	retire(session: string): Promise<void>;
	/** Binds `scope` to `session` unless another session holds it; whether `session` holds it now. */
	claim(scope: string, session: string): Promise<boolean>;
}

const isGeneration = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

class HandLinkStateCorruptError extends Error {
	constructor(key: string, reason: string) {
		super(`hand_link state: ${key} ${reason}`);
		this.name = "HandLinkStateCorruptError";
	}
}

function decodeSession(key: string, data: StoreValue): SessionRecord {
	const field = (name: string): unknown =>
		typeof data === "object" && data !== null && !Array.isArray(data) ? Reflect.get(data, name) : undefined;
	const [lowest, owner, loopId, closed] = [field("lowest"), field("owner"), field("loopId"), field("closed")];
	if (!isGeneration(lowest)) throw new HandLinkStateCorruptError(key, "has no lowest generation of at least 1");
	if (closed !== undefined && closed !== true) throw new HandLinkStateCorruptError(key, "has a malformed closed mark");
	const marks = closed === true ? { closed: true as const } : {};
	if (owner === undefined && loopId === undefined) return { lowest, ...marks };
	if (typeof owner !== "string" || typeof loopId !== "string")
		throw new HandLinkStateCorruptError(key, "has a malformed holder");
	return { lowest, holder: { owner, loopId }, ...marks };
}

/** Claims `store` for `token` (this daemon's endpoint) and loads what an earlier process left in it. */
export async function openHandLinkState(store: LockedFileStore, token: string): Promise<HandLinkState> {
	const epoch = await store.claimFor(token);
	const admission = createAdmissionLine();
	const sessions = new Map<string, SessionRecord>();
	const scopes = new Map<string, string>();
	for (const { key, data } of await store.scanDocuments(SESSION_PREFIX))
		sessions.set(key.slice(SESSION_PREFIX.length), decodeSession(key, data));
	for (const { key, data } of await store.scanDocuments(SCOPE_PREFIX)) {
		if (typeof data !== "string") throw new HandLinkStateCorruptError(key, "does not name a session");
		scopes.set(key.slice(SCOPE_PREFIX.length), data);
	}
	const fence = createHandEpochFence({
		ownerOf: (scope) => {
			const session = scopes.get(scope);
			return session === undefined ? undefined : sessions.get(session)?.holder?.owner;
		},
		durable: { store, epoch, admission },
	});
	await fence.ready;
	const commit = (writes: readonly StoreWrite[], adopt: () => void): Promise<void> =>
		admission.admit(async () => {
			await store.commit(epoch, writes, adopt);
		});
	const sessionWrite = (session: string, record: SessionRecord): StoreWrite => ({
		op: "put",
		key: `${SESSION_PREFIX}${session}`,
		data: { lowest: record.lowest, ...record.holder, ...(record.closed ? { closed: true } : {}) },
	});
	const putSession = (session: string, record: SessionRecord): Promise<void> =>
		commit([sessionWrite(session, record)], () => sessions.set(session, record));
	return {
		fence,
		owned: async () => (await store.owner()) === token,
		session: (session) => sessions.get(session),
		admit: (session, generation, holder) => putSession(session, { lowest: generation, holder }),
		end: (session, lowest) => putSession(session, { lowest }),
		async retire(session) {
			const held = [...scopes].flatMap(([scope, holder]) => (holder === session ? [scope] : []));
			const tombstone: SessionRecord = { lowest: sessions.get(session)?.lowest ?? 1, closed: true };
			const writes: StoreWrite[] = [
				sessionWrite(session, tombstone),
				...held.flatMap((scope): StoreWrite[] => [
					{ op: "delete", key: `${SCOPE_PREFIX}${scope}` },
					{ op: "delete", key: `${EPOCH_FLOOR_PREFIX}${scope}` },
				]),
			];
			await commit(writes, () => {
				sessions.set(session, tombstone);
				for (const scope of held) scopes.delete(scope);
			});
		},
		async claim(scope, session) {
			const holder = scopes.get(scope);
			if (holder !== undefined) return holder === session;
			await commit([{ op: "put", key: `${SCOPE_PREFIX}${scope}`, data: session }], () => scopes.set(scope, session));
			return true;
		},
	};
}
