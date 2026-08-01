import { uuidv7 } from "@earendil-works/pi-ai";
import {
	type FileError,
	type Result,
	type SessionCreateOptions,
	SessionError,
	type SessionForkOptions,
	type SessionMetadata,
	type SessionSearch,
	type SessionSearchHit,
	type SessionStore,
	type SessionTreeEntry,
} from "../types.ts";
import { createSessionForkSelection } from "./fork.ts";
import { createSessionFromReader, type Session, type SessionContextBuildOptions } from "./session.ts";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export class SessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	private readonly store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	private readonly searchStore: SessionSearch<TMetadata> | null;
	private readonly contextBuildOptions: SessionContextBuildOptions;

	constructor(options: {
		store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
		search?: SessionSearch<TMetadata> | null;
		contextBuildOptions?: SessionContextBuildOptions;
	}) {
		this.store = options.store;
		this.searchStore = options.search ?? null;
		this.contextBuildOptions = options.contextBuildOptions ?? {};
	}

	async create(options: TCreateOptions): Promise<Session<TMetadata>> {
		return createSessionFromReader(this.store, await this.store.create(options), this.contextBuildOptions);
	}

	async open(metadata: TMetadata): Promise<Session<TMetadata>> {
		return createSessionFromReader(this.store, await this.store.load(metadata), this.contextBuildOptions);
	}

	async list(options?: TListOptions): Promise<TMetadata[]> {
		return await this.store.list(options);
	}

	async delete(metadata: TMetadata): Promise<void> {
		await this.store.delete(metadata);
	}

	async fork(source: TMetadata, options: SessionForkOptions & TCreateOptions): Promise<Session<TMetadata>> {
		const selection = createSessionForkSelection(options);
		const createOptions = { ...options };
		delete createOptions.entryId;
		delete createOptions.position;
		return createSessionFromReader(
			this.store,
			await this.store.fork(source, createOptions, selection),
			this.contextBuildOptions,
		);
	}

	async search(options: Parameters<SessionSearch<TMetadata>["search"]>[0]): Promise<SessionSearchHit<TMetadata>[]> {
		return this.searchStore ? await this.searchStore.search(options) : [];
	}
}

export function createSessionRepository<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
>(options: {
	store: SessionStore<TMetadata, TCreateOptions, TListOptions>;
	search?: SessionSearch<TMetadata> | null;
	contextBuildOptions?: SessionContextBuildOptions;
}): SessionRepository<TMetadata, TCreateOptions, TListOptions> {
	return new SessionRepository(options);
}

export function findSessionEntryMatches<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	entries: readonly SessionTreeEntry[],
	text: string,
): SessionSearchHit<TMetadata>[] {
	const normalizedText = text.trim().toLowerCase();
	if (!normalizedText) return [];
	return entries.flatMap((entry) => {
		const payload = JSON.stringify(entry);
		if (!payload.toLowerCase().includes(normalizedText)) return [];
		return [{ metadata, entryId: entry.id, timestamp: entry.timestamp, snippet: payload }];
	});
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}
