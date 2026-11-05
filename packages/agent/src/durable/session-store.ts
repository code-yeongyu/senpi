import type { DurableStore, StoreValue, StoreWrite, SyncCommitStore } from "./store.ts";

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
const sessionManifestKey = (id: string): string => SESSION + encodeURIComponent(id);
const sessionRecordKind = (id: string): string => `session/${encodeURIComponent(id)}`;

export interface SessionState extends StoredSession {
	readonly divergence: StoreValue;
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
	let header: SessionHeader = manifest.header;
	let entries: StoredEntry[] = [];
	let held = new Set<string>();
	for (const record of await store.scanRecords({ kind: sessionRecordKind(id), order: "asc" })) {
		const data = record.data;
		if (isRecord(data) && data.op === "rewrite" && isRecord(data.header) && Array.isArray(data.entries)) {
			header = data.header;
			entries = data.entries.map((entry) => readEntry(id, entry));
			held = new Set(entries.map((entry) => entry.key));
		} else if (isRecord(data) && data.op === "append") {
			const entry = readEntry(id, data);
			if (held.has(entry.key)) continue;
			held.add(entry.key);
			entries.push(entry);
		} else {
			throw new SessionStoreError("corrupt-session", `session ${id} holds an unreadable record ${record.seq}`);
		}
	}
	return { id, header, entries, divergence: manifest.divergence ?? null };
}

/** The manifest of a new session (or one whose header or divergence changes): no entry list, by design. */
export const manifestWrite = (id: string, header: SessionHeader, divergence: StoreValue): StoreWrite => ({
	op: "put",
	key: sessionManifestKey(id),
	data: { id, header, divergence },
});

export const appendRecordWrites = (store: DurableStore, id: string, added: readonly StoredEntry[]): StoreWrite[] =>
	added.map((entry) => ({
		op: "append",
		id: store.mintId(),
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

function planAppend(store: DurableStore, state: SessionState, held: boolean, added: readonly StoredEntry[]): Plan {
	refuseRepeats(
		state.id,
		added,
		state.entries.map((entry) => entry.key),
		"session",
	);
	const next = { ...state, entries: [...state.entries, ...added] };
	const create = held ? [] : [manifestWrite(state.id, state.header, state.divergence)];
	return { writes: [...create, ...appendRecordWrites(store, state.id, added)], next };
}

function planRewrite(
	store: DurableStore,
	state: SessionState,
	header: SessionHeader,
	entries: readonly StoredEntry[],
): Plan {
	refuseRepeats(state.id, entries, [], "rewrite of");
	const next = { ...state, header, entries: [...entries] };
	return {
		writes: [manifestWrite(state.id, header, state.divergence), rewriteRecordWrite(store, state.id, header, entries)],
		next,
	};
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
		? { state: { id, header, entries: [], divergence: null }, held: false }
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
					await store.commit(epoch, next.writes, () => {});
					state = next.next;
					held = true;
				});
				tail = run.catch(() => undefined);
				return run;
			};
			return {
				header: () => state.header,
				entries: () => state.entries,
				append: (entries) => enqueue(() => planAppend(store, state, held, entries)),
				rewrite: (header2, entries) => enqueue(() => planRewrite(store, state, header2, entries)),
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
				store.commitSync(epoch, plan.writes, () => {});
				state = plan.next;
				held = true;
			};
			return {
				header: () => state.header,
				entries: () => state.entries,
				appendSync: (entries) => commit(planAppend(store, state, held, entries)),
				rewriteSync: (header2, entries) => commit(planRewrite(store, state, header2, entries)),
			};
		},
	};
}
