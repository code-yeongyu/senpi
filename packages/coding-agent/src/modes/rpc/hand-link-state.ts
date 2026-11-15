/**
 * What the `hand_link` endpoint must remember across a daemon restart, in one durable store on one admission line:
 * the hand's epoch floors (`createHandEpochFence`), each hosted session's link record (the lowest generation it may
 * still open, and the owner and loop admitted at its generation) and which session each scope belongs to. A restarted
 * daemon then acks a session's floor at the generation it reached, and still refuses an older generation or a second
 * sender at that one.
 */
import { createAdmissionLine, createHandEpochFence, type HandEpochFence } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreValue, StoreWrite } from "@earendil-works/pi-agent-core/conformance";

const SESSION_PREFIX = "hand-link.session:";
const SCOPE_PREFIX = "hand-link.scope:";

/** A session's link record: the lowest generation it may open, and who holds the generation admitted last. */
export interface SessionRecord {
	readonly lowest: number;
	readonly holder?: { readonly owner: string; readonly loopId: string };
}

export interface HandLinkState {
	readonly fence: HandEpochFence;
	session(session: string): SessionRecord | undefined;
	/** Records `owner`'s `loopId` as the session's link at `generation`. */
	admit(session: string, generation: number, holder: NonNullable<SessionRecord["holder"]>): Promise<void>;
	/** Ends the session's link: nothing is held and only `lowest` or above may open it again. */
	end(session: string, lowest: number): Promise<void>;
	/** Binds `scope` to `session` unless another session holds it; whether `session` holds it now. */
	claim(scope: string, session: string): Promise<boolean>;
}

function decodeSession(data: StoreValue): SessionRecord {
	const field = (name: string): unknown =>
		typeof data === "object" && data !== null ? Reflect.get(data, name) : undefined;
	const [lowest, owner, loopId] = [field("lowest"), field("owner"), field("loopId")];
	if (typeof lowest !== "number") throw new Error("A stored hand_link session record is malformed");
	return typeof owner === "string" && typeof loopId === "string" ? { lowest, holder: { owner, loopId } } : { lowest };
}

/** Claims `store` for this process (the next owner epoch) and loads what an earlier process left in it. */
export async function openHandLinkState(store: DurableStore): Promise<HandLinkState> {
	const before = await store.readEpoch();
	const epoch = before + 1;
	await store.claim(before, epoch);
	const admission = createAdmissionLine();
	const sessions = new Map<string, SessionRecord>();
	const scopes = new Map<string, string>();
	for (const { key, data } of await store.scanDocuments(SESSION_PREFIX))
		sessions.set(key.slice(SESSION_PREFIX.length), decodeSession(data));
	for (const { key, data } of await store.scanDocuments(SCOPE_PREFIX))
		if (typeof data === "string") scopes.set(key.slice(SCOPE_PREFIX.length), data);
	const fence = createHandEpochFence({
		ownerOf: (scope) => {
			const session = scopes.get(scope);
			return session === undefined ? undefined : sessions.get(session)?.holder?.owner;
		},
		durable: { store, epoch, admission },
	});
	await fence.ready;
	const commit = (write: StoreWrite, adopt: () => void): Promise<void> =>
		admission.admit(async () => {
			await store.commit(epoch, [write], adopt);
		});
	const putSession = (session: string, record: SessionRecord): Promise<void> =>
		commit(
			{
				op: "put",
				key: `${SESSION_PREFIX}${session}`,
				data: { lowest: record.lowest, ...record.holder },
			},
			() => sessions.set(session, record),
		);
	return {
		fence,
		session: (session) => sessions.get(session),
		admit: (session, generation, holder) => putSession(session, { lowest: generation, holder }),
		end: (session, lowest) => putSession(session, { lowest }),
		async claim(scope, session) {
			const holder = scopes.get(scope);
			if (holder !== undefined) return holder === session;
			await commit({ op: "put", key: `${SCOPE_PREFIX}${scope}`, data: session }, () => scopes.set(scope, session));
			return true;
		},
	};
}
