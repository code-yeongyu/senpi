import {
	type DurableStore,
	DurableStoreError,
	type StoreValue,
	type StoreWrite,
	type SyncCommitStore,
} from "./store.ts";

export interface StoredEntry {
	readonly key: string;
	readonly line: string;
}

export type SessionHeader = { readonly [key: string]: StoreValue };

export interface StoredSession {
	readonly id: string;
	readonly header: SessionHeader;
	readonly entries: readonly StoredEntry[];
}

export type SessionStoreErrorCode = "duplicate-entry" | "corrupt-session";

export class SessionStoreError extends Error {
	readonly code: SessionStoreErrorCode;

	constructor(code: SessionStoreErrorCode, message: string) {
		super(message);
		this.name = "SessionStoreError";
		this.code = code;
	}
}

// One layout for both writers (this store and the S07 JSONL importer, coding-agent session-import/jsonl-import.ts).
// A session's entries are records in the store's append-only log, one kind per session, so sqlite orders the appends of
// every process bound to the session and none is lost. A record is an append (one entry) or a rewrite (the full header
// and entry list, replacing everything before it). The manifest document holds only what is not ordered: the header a
// new session starts with, and its divergence.
const SESSION = "session-import/session/";
const DIVERGENCE = "session-import/divergence/";
const sessionManifestKey = (id: string): string => SESSION + encodeURIComponent(id);
const divergenceKey = (id: string): string => DIVERGENCE + encodeURIComponent(id);
const sessionRecordKind = (id: string): string => `session/${encodeURIComponent(id)}`;

export interface SessionState extends StoredSession {
	readonly divergence: StoreValue;
	/** How many rewrite records the session holds; an append record's id is scoped to it. */
	readonly rewrites: number;
}

type Plan = { readonly writes: readonly StoreWrite[]; readonly next: SessionState };

const isRecord = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readEntry(id: string, value: StoreValue): StoredEntry {
	if (isRecord(value) && typeof value.key === "string" && typeof value.line === "string") {
		return { key: value.key, line: value.line };
	}
	throw new SessionStoreError("corrupt-session", `session ${id} holds an unreadable entry record`);
}

/** The session as committed: the last rewrite, then every later append; a key seen twice keeps its first record. */
export async function readSessionState(store: DurableStore, id: string): Promise<SessionState | undefined> {
	const manifest = await store.getDocument(sessionManifestKey(id));
	if (manifest === undefined) return undefined;
	if (!isRecord(manifest) || !isRecord(manifest.header)) {
		throw new SessionStoreError("corrupt-session", `session ${id} has no readable manifest`);
	}
	if ("entryIds" in manifest) {
		throw new SessionStoreError(
			"corrupt-session",
			`session ${id} is stored in the layout before the record log; re-import it from its JSONL file`,
		);
	}
	let header: SessionHeader = manifest.header;
	let entries: StoredEntry[] = [];
	let held = new Set<string>();
	let rewrites = 0;
	for (const record of await store.scanRecords({ kind: sessionRecordKind(id), order: "asc" })) {
		const data = record.data;
		if (isRecord(data) && data.op === "rewrite" && isRecord(data.header) && Array.isArray(data.entries)) {
			header = data.header;
			entries = data.entries.map((entry) => readEntry(id, entry));
			held = new Set(entries.map((entry) => entry.key));
			rewrites++;
		} else if (isRecord(data) && data.op === "append") {
			const entry = readEntry(id, data);
			if (held.has(entry.key)) continue;
			held.add(entry.key);
			entries.push(entry);
		} else {
			throw new SessionStoreError("corrupt-session", `session ${id} holds an unreadable record ${record.seq}`);
		}
	}
	const divergence = (await store.getDocument(divergenceKey(id))) ?? null;
	return { id, header, entries, divergence, rewrites };
}

/** A new session's manifest: its id and starting header. Written once, never by a later write of the session. */
export const manifestWrite = (id: string, header: SessionHeader): StoreWrite => ({
	op: "put",
	key: sessionManifestKey(id),
	data: { id, header },
});

/** The session's divergence marker; only the S07 importer writes it, so a handle's write can never clobber it. */
export const divergenceWrite = (id: string, divergence: StoreValue): StoreWrite => ({
	op: "put",
	key: divergenceKey(id),
	data: divergence,
});

/**
 * One record per entry, its id derived from the session, its rewrite count and the key: two processes appending the
 * same key to the same session collide on the id, so the store refuses the second batch (`duplicate-record-id`).
 */
export const appendRecordWrites = (id: string, rewrites: number, added: readonly StoredEntry[]): StoreWrite[] =>
	added.map((entry) => ({
		op: "append",
		id: `${sessionRecordKind(id)}/${rewrites}/${encodeURIComponent(entry.key)}`,
		kind: sessionRecordKind(id),
		data: { op: "append", key: entry.key, line: entry.line },
	}));

export const rewriteRecordWrite = (
	store: DurableStore,
	id: string,
	header: SessionHeader,
	entries: readonly StoredEntry[],
): StoreWrite => ({
	op: "append",
	id: store.mintId(),
	kind: sessionRecordKind(id),
	data: { op: "rewrite", header, entries: entries.map((entry) => ({ key: entry.key, line: entry.line })) },
});

function refuseRepeats(id: string, entries: readonly StoredEntry[], held: Iterable<string>, what: string): void {
	const seen = new Set(held);
	for (const entry of entries) {
		if (seen.has(entry.key)) throw new SessionStoreError("duplicate-entry", `${what} ${id} repeats ${entry.key}`);
		seen.add(entry.key);
	}
}

function planAppend(state: SessionState, held: boolean, added: readonly StoredEntry[]): Plan {
	refuseRepeats(
		state.id,
		added,
		state.entries.map((entry) => entry.key),
		"session",
	);
	const next = { ...state, entries: [...state.entries, ...added] };
	const create = held ? [] : [manifestWrite(state.id, state.header)];
	return { writes: [...create, ...appendRecordWrites(state.id, state.rewrites, added)], next };
}

function planRewrite(
	store: DurableStore,
	state: SessionState,
	held: boolean,
	header: SessionHeader,
	entries: readonly StoredEntry[],
): Plan {
	refuseRepeats(state.id, entries, [], "rewrite of");
	const next = { ...state, header, entries: [...entries], rewrites: state.rewrites + 1 };
	const create = held ? [] : [manifestWrite(state.id, header)];
	return { writes: [...create, rewriteRecordWrite(store, state.id, header, entries)], next };
}

/** Another process committed the same entry key first: the store refused the batch on its record id. */
function asDuplicateEntry(id: string, error: unknown): unknown {
	return error instanceof DurableStoreError && error.code === "duplicate-record-id"
		? new SessionStoreError("duplicate-entry", `session ${id} already holds an entry this write repeats`)
		: error;
}

const stored = ({ id, header, entries }: SessionState): StoredSession => ({ id, header, entries });

/** An existing session keeps its stored header; `header` only seeds a session the store does not hold yet. */
async function openState(
	store: DurableStore,
	id: string,
	header: SessionHeader,
): Promise<{ state: SessionState; held: boolean }> {
	const read = await readSessionState(store, id);
	return read === undefined
		? { state: { id, header, entries: [], divergence: null, rewrites: 0 }, held: false }
		: { state: read, held: true };
}

export interface SessionHandle {
	header(): SessionHeader;
	entries(): readonly StoredEntry[];
	append(entries: readonly StoredEntry[]): Promise<void>;
	rewrite(header: SessionHeader, entries: readonly StoredEntry[]): Promise<void>;
}

/** A session on any DurableStore (Durable Object included): every write is one async atomic commit. */
export function openSessionStore(store: DurableStore, epoch: number) {
	return {
		load: async (id: string): Promise<StoredSession | undefined> => {
			const state = await readSessionState(store, id);
			return state === undefined ? undefined : stored(state);
		},
		open: async (id: string, header: SessionHeader): Promise<SessionHandle> => {
			let { state, held } = await openState(store, id, header);
			// One write at a time, each planned from the state the previous one committed.
			let tail: Promise<void> = Promise.resolve();
			const enqueue = (plan: () => Plan): Promise<void> => {
				const run = tail.then(async () => {
					const next = plan();
					await store
						.commit(epoch, next.writes, () => {})
						.catch((error: unknown) => {
							throw asDuplicateEntry(id, error);
						});
					state = next.next;
					held = true;
				});
				tail = run.catch(() => undefined);
				return run;
			};
			return {
				header: () => state.header,
				entries: () => state.entries,
				append: (entries) => enqueue(() => planAppend(state, held, entries)),
				rewrite: (header2, entries) => enqueue(() => planRewrite(store, state, held, header2, entries)),
			};
		},
	};
}

export interface SyncSessionHandle {
	header(): SessionHeader;
	entries(): readonly StoredEntry[];
	/** Durable when it returns; a refusal throws on this call and leaves the session and the store unchanged. */
	appendSync(entries: readonly StoredEntry[]): void;
	rewriteSync(header: SessionHeader, entries: readonly StoredEntry[]): void;
}

/** A session whose writes commit synchronously: only a backend with `commitSync` (memory, Bun SQLite) can build one. */
export function openSyncSessionStore(store: SyncCommitStore, epoch: number) {
	return {
		load: openSessionStore(store, epoch).load,
		open: async (id: string, header: SessionHeader): Promise<SyncSessionHandle> => {
			let { state, held } = await openState(store, id, header);
			const commit = (plan: Plan): void => {
				try {
					store.commitSync(epoch, plan.writes, () => {});
				} catch (error) {
					throw asDuplicateEntry(id, error);
				}
				state = plan.next;
				held = true;
			};
			return {
				header: () => state.header,
				entries: () => state.entries,
				appendSync: (entries) => commit(planAppend(state, held, entries)),
				rewriteSync: (header2, entries) => commit(planRewrite(store, state, held, header2, entries)),
			};
		},
	};
}
