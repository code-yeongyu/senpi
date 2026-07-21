import { existsSync, unlinkSync } from "node:fs";
import type { AgentSession } from "../../../core/agent-session.ts";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
} from "../../../core/sdk.ts";
import { type SessionInfo, SessionManager } from "../../../core/session-manager.ts";
import { resolvePath } from "../../../utils/paths.ts";
import {
	createMcpWireStatusRegistry,
	type McpWireStatusAdapter,
	type McpWireStatusRegistry,
} from "./mcp-wire-status.ts";
import { buildDiskThread, compareThreads, decodeCursor, encodeCursor } from "./registry-listing.ts";

export type ConnectionId = string;

export interface RpcNotification {
	method: string;
	params?: unknown;
}

export interface ActiveTurn {
	turnId: string;
	startedAt: string;
}

export type LoadedThreadStatus = "idle" | "active";
export type ThreadStatusType = LoadedThreadStatus | "notLoaded";

export interface WireThread {
	id: string;
	sessionId: string;
	sessionPath: string | null;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	status: { type: ThreadStatusType };
	preview: string | null;
	name: string | null;
}

export interface ThreadEntry {
	id: string;
	session: AgentSession;
	cwd: string;
	subscribers: Set<ConnectionId>;
	activeTurn: ActiveTurn | null;
	queuedTerminalNotifications: RpcNotification[];
	status: LoadedThreadStatus;
	taskQueue: Promise<void>;
	createdAt: string;
	updatedAt: string;
	mcpWireStatusAdapter: McpWireStatusAdapter | undefined;
}

export type AppServerSessionResult = CreateAgentSessionResult & {
	readonly mcpWireStatusAdapter?: McpWireStatusAdapter;
};

export interface CreateThreadOptions {
	cwd: string;
	model?: CreateAgentSessionOptions["model"];
}

export interface ListThreadsOptions {
	cursor?: string | null;
	limit?: number;
}

export interface ListThreadsResult {
	threads: WireThread[];
	nextCursor: string | null;
}

export interface ThreadRegistryOptions {
	agentDir?: string;
	sessionDir?: string;
	createSession?: (options: CreateAgentSessionOptions) => Promise<AppServerSessionResult>;
	mcpWireStatusAdapter?: McpWireStatusAdapter;
}

export class ThreadNotFoundError extends Error {
	readonly threadId: string;

	constructor(threadId: string) {
		super(`Thread not found: ${threadId}`);
		this.name = "ThreadNotFoundError";
		this.threadId = threadId;
	}
}

export class ThreadRegistry {
	private readonly entries = new Map<string, ThreadEntry>();
	private readonly deletedThreadIds = new Set<string>();
	private readonly agentDir: string | undefined;
	private readonly sessionDir: string | undefined;
	private readonly createSession: (options: CreateAgentSessionOptions) => Promise<AppServerSessionResult>;
	private readonly mcpWireStatuses: McpWireStatusRegistry;

	constructor(options: ThreadRegistryOptions = {}) {
		this.agentDir = options.agentDir ? resolvePath(options.agentDir) : undefined;
		this.sessionDir = options.sessionDir ? resolvePath(options.sessionDir) : undefined;
		this.createSession = options.createSession ?? createAgentSession;
		this.mcpWireStatuses = createMcpWireStatusRegistry(options.mcpWireStatusAdapter);
	}

	async createThread(options: CreateThreadOptions): Promise<ThreadEntry> {
		const cwd = resolvePath(options.cwd);
		const sessionManager = SessionManager.create(cwd, this.sessionDir);
		const result = await this.createSession({
			cwd,
			agentDir: this.agentDir,
			sessionManager,
			model: options.model,
		});
		this.deletedThreadIds.delete(result.session.sessionId);
		return this.registerSession(result.session, cwd, undefined, result.mcpWireStatusAdapter);
	}

	async resumeThread(threadId: string): Promise<ThreadEntry> {
		const loaded = this.entries.get(threadId);
		if (loaded) {
			return loaded;
		}
		if (this.deletedThreadIds.has(threadId)) {
			throw new ThreadNotFoundError(threadId);
		}

		const sessionInfo = await this.findSessionInfo(threadId);
		if (!sessionInfo) {
			throw new ThreadNotFoundError(threadId);
		}

		const sessionManager = SessionManager.open(sessionInfo.path, this.sessionDir, sessionInfo.cwd || undefined);
		const result = await this.createSession({
			cwd: sessionManager.getCwd(),
			agentDir: this.agentDir,
			sessionManager,
		});
		return this.registerSession(result.session, sessionManager.getCwd(), sessionInfo, result.mcpWireStatusAdapter);
	}

	async forkThread(threadId: string, options: Partial<CreateThreadOptions> = {}): Promise<ThreadEntry> {
		const source = await this.resumeThread(threadId);
		const cwd = resolvePath(options.cwd ?? source.cwd);
		const sourceFile = source.session.sessionFile;
		const sessionManager =
			sourceFile && existsSync(sourceFile)
				? SessionManager.forkFrom(sourceFile, cwd, this.sessionDir)
				: SessionManager.create(cwd, this.sessionDir, sourceFile ? { parentSession: sourceFile } : undefined);
		const result = await this.createSession({
			cwd,
			agentDir: this.agentDir,
			sessionManager,
			model: options.model,
		});
		this.deletedThreadIds.delete(result.session.sessionId);
		return this.registerSession(result.session, cwd, undefined, result.mcpWireStatusAdapter);
	}

	async deleteThread(threadId: string): Promise<boolean> {
		const loaded = this.entries.get(threadId);
		if (loaded) {
			loaded.session.dispose();
			this.entries.delete(threadId);
			this.mcpWireStatuses.removeThread(threadId);
			this.deletedThreadIds.add(threadId);
			const sessionFile = loaded.session.sessionFile;
			if (sessionFile && existsSync(sessionFile)) {
				unlinkSync(sessionFile);
			}
			return true;
		}

		const sessionInfo = await this.findSessionInfo(threadId);
		if (!sessionInfo) {
			this.deletedThreadIds.add(threadId);
			return false;
		}
		if (existsSync(sessionInfo.path)) {
			unlinkSync(sessionInfo.path);
		}
		this.deletedThreadIds.add(threadId);
		return true;
	}

	listLoaded(): WireThread[] {
		return [...this.entries.values()].map((entry) => this.buildLoadedThread(entry));
	}

	async listThreads(options: ListThreadsOptions = {}): Promise<ListThreadsResult> {
		const offset = decodeCursor(options.cursor);
		const limit = Math.max(0, options.limit ?? 50);
		const threadsById = new Map<string, WireThread>();

		for (const info of await this.listSessionInfos()) {
			if (!this.deletedThreadIds.has(info.id)) {
				threadsById.set(info.id, buildDiskThread(info));
			}
		}
		for (const entry of this.entries.values()) {
			threadsById.set(entry.id, this.buildLoadedThread(entry));
		}

		const threads = [...threadsById.values()].sort(compareThreads);
		const page = threads.slice(offset, offset + limit);
		const nextOffset = offset + page.length;
		return {
			threads: page,
			nextCursor: nextOffset < threads.length ? encodeCursor(nextOffset) : null,
		};
	}

	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T> {
		const entry = this.getLoadedThread(threadId);
		const run = entry.taskQueue.then(task, task);
		entry.taskQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	getLoadedThread(threadId: string): ThreadEntry {
		const entry = this.entries.get(threadId);
		if (!entry) {
			throw new ThreadNotFoundError(threadId);
		}
		return entry;
	}

	getMcpWireStatusAdapter(threadId?: string | null): McpWireStatusAdapter | undefined {
		const adapter = this.mcpWireStatuses.resolve(threadId);
		if (adapter !== undefined || threadId === undefined || threadId === null) return adapter;
		this.getLoadedThread(threadId);
		return undefined;
	}

	unloadThread(threadId: string): boolean {
		const entry = this.entries.get(threadId);
		entry?.session.dispose();
		this.mcpWireStatuses.removeThread(threadId);
		return this.entries.delete(threadId);
	}

	buildThread(entry: ThreadEntry): WireThread {
		return this.buildLoadedThread(entry);
	}

	getSessionDir(): string | undefined {
		return this.sessionDir;
	}

	private registerSession(
		session: AgentSession,
		cwd: string,
		sessionInfo?: SessionInfo,
		mcpWireStatusAdapter?: McpWireStatusAdapter,
	): ThreadEntry {
		const existing = this.entries.get(session.sessionId);
		if (existing) {
			if (mcpWireStatusAdapter !== undefined) {
				existing.mcpWireStatusAdapter = mcpWireStatusAdapter;
				this.mcpWireStatuses.registerThread(session.sessionId, mcpWireStatusAdapter);
			}
			if (existing.session !== session) {
				session.dispose();
			}
			return existing;
		}

		const now = new Date().toISOString();
		const entry: ThreadEntry = {
			id: session.sessionId,
			session,
			cwd,
			subscribers: new Set<ConnectionId>(),
			activeTurn: null,
			queuedTerminalNotifications: [],
			status: "idle",
			taskQueue: Promise.resolve(),
			createdAt: sessionInfo?.created.toISOString() ?? now,
			updatedAt: sessionInfo?.modified.toISOString() ?? now,
			mcpWireStatusAdapter,
		};
		this.entries.set(entry.id, entry);
		if (mcpWireStatusAdapter !== undefined) {
			this.mcpWireStatuses.registerThread(entry.id, mcpWireStatusAdapter);
		}
		return entry;
	}

	private async findSessionInfo(threadId: string): Promise<SessionInfo | undefined> {
		return (await this.listSessionInfos()).find((info) => info.id === threadId);
	}

	private async listSessionInfos(): Promise<SessionInfo[]> {
		if (this.sessionDir) {
			return SessionManager.listAll(this.sessionDir);
		}
		return SessionManager.listAll();
	}

	private buildLoadedThread(entry: ThreadEntry): WireThread {
		return {
			id: entry.id,
			sessionId: entry.session.sessionId,
			sessionPath: entry.session.sessionFile ?? null,
			cwd: entry.cwd,
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
			status: { type: entry.status },
			preview: entry.session.getUserMessagesForForking()[0]?.text ?? null,
			name: entry.session.sessionName ?? null,
		};
	}
}
