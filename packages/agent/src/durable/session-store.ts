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

// The S07 JSONL importer's key schema (coding-agent session-import/jsonl-import.ts): one format for both writers.
const SESSION = "session-import/session/";
const ENTRY = "session-import/entry/";
const sessionKey = (id: string): string => SESSION + encodeURIComponent(id);
const entryKey = (sessionId: string, key: string): string =>
	`${ENTRY}${encodeURIComponent(sessionId)}/${encodeURIComponent(key)}`;

interface SessionState extends StoredSession {
	readonly divergence: StoreValue;
}

type Plan = { readonly writes: readonly StoreWrite[]; readonly next: SessionState };

const isRecord = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

async function readState(store: DurableStore, id: string): Promise<SessionState | undefined> {
	const manifest = await store.getDocument(sessionKey(id));
	if (manifest === undefined) return undefined;
	const entryIds = isRecord(manifest) ? manifest.entryIds : undefined;
	if (!isRecord(manifest) || !isRecord(manifest.header) || !Array.isArray(entryIds)) {
		throw new SessionStoreError("corrupt-session", `session ${id} has no readable manifest`);
	}
	const entries: StoredEntry[] = [];
	for (const key of entryIds) {
		const line = typeof key === "string" ? await store.getDocument(entryKey(id, key)) : undefined;
		if (typeof key !== "string" || typeof line !== "string") {
			throw new SessionStoreError("corrupt-session", `session ${id} is missing entry ${String(key)}`);
		}
		entries.push({ key, line });
	}
	return { id, header: manifest.header, entries, divergence: manifest.divergence ?? null };
}

const manifestWrite = (state: SessionState): StoreWrite => ({
	op: "put",
	key: sessionKey(state.id),
	data: { id: state.id, header: state.header, entryIds: state.entries.map((entry) => entry.key), divergence: state.divergence },
});

function planAppend(state: SessionState, added: readonly StoredEntry[]): Plan {
	const held = new Set(state.entries.map((entry) => entry.key));
	for (const entry of added) {
		if (held.has(entry.key)) throw new SessionStoreError("duplicate-entry", `session ${state.id} already holds ${entry.key}`);
		held.add(entry.key);
	}
	const next = { ...state, entries: [...state.entries, ...added] };
	const puts = added.map((entry): StoreWrite => ({ op: "put", key: entryKey(state.id, entry.key), data: entry.line }));
	return { writes: [...puts, manifestWrite(next)], next };
}

function planRewrite(state: SessionState, header: SessionHeader, entries: readonly StoredEntry[]): Plan {
	const kept = new Set<string>();
	for (const entry of entries) {
		if (kept.has(entry.key)) throw new SessionStoreError("duplicate-entry", `rewrite of ${state.id} repeats ${entry.key}`);
		kept.add(entry.key);
	}
	const next = { ...state, header, entries: [...entries] };
	const deletes = state.entries
		.filter((entry) => !kept.has(entry.key))
		.map((entry): StoreWrite => ({ op: "delete", key: entryKey(state.id, entry.key) }));
	const puts = entries.map((entry): StoreWrite => ({ op: "put", key: entryKey(state.id, entry.key), data: entry.line }));
	return { writes: [...deletes, ...puts, manifestWrite(next)], next };
}

const stored = ({ id, header, entries }: SessionState): StoredSession => ({ id, header, entries });

async function openState(store: DurableStore, id: string, header: SessionHeader): Promise<SessionState> {
	return (await readState(store, id)) ?? { id, header, entries: [], divergence: null };
}

export interface SessionHandle {
	entries(): readonly StoredEntry[];
	append(entries: readonly StoredEntry[]): Promise<void>;
	rewrite(header: SessionHeader, entries: readonly StoredEntry[]): Promise<void>;
}

/** A session on any DurableStore (Durable Object included): every write is one async atomic commit. */
export function openSessionStore(store: DurableStore, epoch: number) {
	return {
		load: async (id: string): Promise<StoredSession | undefined> => {
			const state = await readState(store, id);
			return state === undefined ? undefined : stored(state);
		},
		open: async (id: string, header: SessionHeader): Promise<SessionHandle> => {
			let state = await openState(store, id, header);
			const commit = async (plan: Plan): Promise<void> => {
				await store.commit(epoch, plan.writes, () => {});
				state = plan.next;
			};
			return {
				entries: () => state.entries,
				append: (entries) => commit(planAppend(state, entries)),
				rewrite: (header2, entries) => commit(planRewrite(state, header2, entries)),
			};
		},
	};
}

export interface SyncSessionHandle {
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
			let state = await openState(store, id, header);
			const commit = (plan: Plan): void => {
				store.commitSync(epoch, plan.writes, () => {});
				state = plan.next;
			};
			return {
				entries: () => state.entries,
				appendSync: (entries) => commit(planAppend(state, entries)),
				rewriteSync: (header2, entries) => commit(planRewrite(state, header2, entries)),
			};
		},
	};
}
