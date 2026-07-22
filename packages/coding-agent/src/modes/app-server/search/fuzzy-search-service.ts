import type {
	FuzzyFileSearchParams,
	FuzzyFileSearchResponse,
	FuzzyFileSearchResult,
	FuzzyFileSearchSessionStartParams,
	FuzzyFileSearchSessionStartResponse,
	FuzzyFileSearchSessionStopParams,
	FuzzyFileSearchSessionStopResponse,
	FuzzyFileSearchSessionUpdateParams,
	FuzzyFileSearchSessionUpdateResponse,
} from "../protocol/fuzzy-search.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { RouterNotification } from "../server/notifications.ts";
import { collectFuzzyFileEntries, type FuzzyFileEntry, rankFuzzyFileEntries } from "./fuzzy-files.ts";

export type FuzzyFileCollector = (roots: readonly string[], signal: AbortSignal) => Promise<readonly FuzzyFileEntry[]>;

export type FuzzyFileRanker = (query: string, entries: readonly FuzzyFileEntry[]) => readonly FuzzyFileSearchResult[];

export type FuzzyFileSearchServiceOptions = {
	readonly broadcast: (notification: RouterNotification) => void;
	readonly collectEntries?: FuzzyFileCollector;
	readonly rankEntries?: FuzzyFileRanker;
};

type SearchSession = {
	readonly id: string;
	readonly roots: readonly string[];
	readonly controller: AbortController;
	query: string;
	version: number;
	entries: readonly FuzzyFileEntry[] | undefined;
	active: boolean;
	completedVersion: number | undefined;
};

export class FuzzyFileSearchService {
	private readonly broadcast: (notification: RouterNotification) => void;
	private readonly collectEntries: FuzzyFileCollector;
	private readonly rankEntries: FuzzyFileRanker;
	private readonly activeSearches = new Set<AbortController>();
	private readonly pendingSearches = new Map<string, AbortController>();
	private readonly sessions = new Map<string, SearchSession>();
	private disposed = false;

	constructor(options: FuzzyFileSearchServiceOptions) {
		this.broadcast = options.broadcast;
		this.collectEntries = options.collectEntries ?? ((roots, signal) => collectFuzzyFileEntries(roots, { signal }));
		this.rankEntries = options.rankEntries ?? rankFuzzyFileEntries;
	}

	async search(params: FuzzyFileSearchParams): Promise<FuzzyFileSearchResponse> {
		if (this.disposed) return { files: [] };
		const controller = new AbortController();
		this.activeSearches.add(controller);
		const token = params.cancellationToken;
		if (token !== null) {
			this.pendingSearches.get(token)?.abort();
			this.pendingSearches.set(token, controller);
		}
		try {
			if (params.query.length === 0) return { files: [] };
			const entries = await this.collectEntries(params.roots, controller.signal);
			if (controller.signal.aborted || this.disposed) return { files: [] };
			return { files: this.rankEntries(params.query, entries) };
		} finally {
			this.activeSearches.delete(controller);
			if (token !== null && this.pendingSearches.get(token) === controller) {
				this.pendingSearches.delete(token);
			}
		}
	}

	startSession(params: FuzzyFileSearchSessionStartParams): FuzzyFileSearchSessionStartResponse {
		if (params.sessionId.length === 0) throw invalidRequest("sessionId must not be empty");
		this.cancelSession(params.sessionId);
		const session: SearchSession = {
			id: params.sessionId,
			roots: params.roots,
			controller: new AbortController(),
			query: "",
			version: 0,
			entries: undefined,
			active: !this.disposed,
			completedVersion: undefined,
		};
		this.sessions.set(session.id, session);
		void this.runTraversal(session);
		return {};
	}

	updateSession(params: FuzzyFileSearchSessionUpdateParams): FuzzyFileSearchSessionUpdateResponse {
		const session = this.sessions.get(params.sessionId);
		if (!session?.active) {
			throw invalidRequest(`fuzzy file search session not found: ${params.sessionId}`);
		}
		session.query = params.query;
		session.version += 1;
		if (session.entries !== undefined) void this.emitVersion(session, session.version);
		return {};
	}

	stopSession(params: FuzzyFileSearchSessionStopParams): FuzzyFileSearchSessionStopResponse {
		this.cancelSession(params.sessionId);
		return {};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const controller of this.activeSearches) controller.abort();
		this.activeSearches.clear();
		this.pendingSearches.clear();
		for (const session of this.sessions.values()) this.deactivate(session);
		this.sessions.clear();
	}

	private async runTraversal(session: SearchSession): Promise<void> {
		let entries: readonly FuzzyFileEntry[];
		try {
			entries = await this.collectEntries(session.roots, session.controller.signal);
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
			entries = [];
		}
		if (!this.isLive(session)) return;
		session.entries = entries;
		while (this.isLive(session)) {
			const version = session.version;
			if (await this.emitVersion(session, version)) break;
		}
	}

	private async emitVersion(session: SearchSession, version: number): Promise<boolean> {
		await Promise.resolve();
		if (!this.isLive(session) || session.version !== version || session.entries === undefined) return false;
		if (session.completedVersion === version) return true;
		const query = session.query;
		const files = query.length === 0 ? [] : this.rankEntries(query, session.entries);
		if (!this.isLive(session) || session.version !== version) return false;
		this.broadcast({ method: "fuzzyFileSearch/sessionUpdated", params: { sessionId: session.id, query, files } });
		if (!this.isLive(session) || session.version !== version) return false;
		session.completedVersion = version;
		this.broadcast({ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: session.id } });
		return true;
	}

	private cancelSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.deactivate(session);
		if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
	}

	private deactivate(session: SearchSession): void {
		session.active = false;
		session.controller.abort();
	}

	private isLive(session: SearchSession): boolean {
		return !this.disposed && session.active && this.sessions.get(session.id) === session;
	}
}

function invalidRequest(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}
