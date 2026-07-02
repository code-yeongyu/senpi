import type {
	ThreadForkResponse,
	ThreadListResponse,
	ThreadLoadedListResponse,
	ThreadReadResponse,
	ThreadResumeResponse,
	ThreadStartResponse,
	ThreadUnsubscribeResponse,
} from "../protocol/generated/v2/index.ts";
import type { MethodRegistry, RegistryConnection, RpcRequest } from "../rpc/registry.ts";
import type { NotificationRouter } from "../server/notifications.ts";
import {
	connectionId,
	decodeCursor,
	encodeCursor,
	objectValue,
	optionalNumber,
	optionalString,
	removeLoadedThread,
	requiredString,
} from "./handler-params.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry, type WireThread } from "./registry.ts";
import type { TurnLog } from "./turn-log.ts";
import { buildWireThread, NOT_LOADED_STATUS } from "./wire-thread.ts";

export interface ThreadLifecycleHandlersOptions {
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly notifications: NotificationRouter;
	readonly idleUnloadMinutes?: number;
	readonly replayPendingApprovals?: (threadId: string, connectionId: string) => void;
}

type RuntimeThreadResponse = ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse;

const DEFAULT_IDLE_UNLOAD_MINUTES = 30;

export function registerThreadLifecycleHandlers(
	registry: MethodRegistry,
	options: ThreadLifecycleHandlersOptions,
): void {
	const handlers = new ThreadLifecycleHandlers(options);
	for (const [method, handler] of handlers.registrations()) {
		registry.register(method, { handler, scope: method.startsWith("thread/") ? "thread" : "global" });
	}
}

class ThreadLifecycleHandlers {
	private readonly threads: ThreadRegistry;
	private readonly turnLog: TurnLog;
	private readonly notifications: NotificationRouter;
	private readonly replayPendingApprovals: ((threadId: string, connectionId: string) => void) | undefined;
	private readonly idleUnloadMs: number;
	private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly archivedThreadIds = new Set<string>();
	private readonly archivedThreads = new Map<string, WireThread>();

	constructor(options: ThreadLifecycleHandlersOptions) {
		this.threads = options.threads;
		this.turnLog = options.turnLog;
		this.notifications = options.notifications;
		this.replayPendingApprovals = options.replayPendingApprovals;
		this.idleUnloadMs = Math.max(0, options.idleUnloadMinutes ?? DEFAULT_IDLE_UNLOAD_MINUTES) * 60 * 1000;
	}

	registrations(): ReadonlyArray<
		readonly [
			string,
			(context: {
				readonly connection: RegistryConnection;
				readonly request: RpcRequest;
			}) => Promise<unknown> | unknown,
		]
	> {
		return [
			["thread/start", (context) => this.start(context.connection, context.request)],
			["thread/resume", (context) => this.resume(context.connection, context.request)],
			["thread/fork", (context) => this.fork(context.connection, context.request)],
			["thread/read", (context) => this.read(context.request)],
			["thread/list", (context) => this.list(context.request)],
			["thread/loaded/list", (context) => this.loadedList(context.request)],
			["thread/name/set", (context) => this.setName(context.request)],
			["thread/archive", (context) => this.archive(context.request)],
			["thread/delete", (context) => this.delete(context.request)],
			["thread/unsubscribe", (context) => this.unsubscribe(context.connection, context.request)],
		];
	}

	private async start(connection: RegistryConnection, request: RpcRequest): Promise<ThreadStartResponse> {
		const params = objectValue(request.params);
		const cwd = optionalString(params.cwd) ?? process.cwd();
		const entry = await this.threads.createThread({ cwd });
		this.attachThread(entry);
		this.subscribe(entry, connectionId(connection));
		const response = this.runtimeResponse(entry, false);
		this.notifications.broadcast({ method: "thread/started", params: { thread: response.thread } });
		return response;
	}

	private async resume(connection: RegistryConnection, request: RpcRequest): Promise<ThreadResumeResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		try {
			const entry = await this.threads.resumeThread(threadId);
			this.attachThread(entry);
			this.subscribe(entry, connectionId(connection));
			return {
				...this.runtimeResponse(entry, true),
				initialTurnsPage: null,
			};
		} catch (error) {
			if (error instanceof ThreadNotFoundError) {
				throw new Error(`no rollout found for thread id ${threadId}`);
			}
			throw error;
		}
	}

	private async fork(connection: RegistryConnection, request: RpcRequest): Promise<ThreadForkResponse> {
		const params = objectValue(request.params);
		const sourceThreadId = requiredString(params.threadId, "threadId");
		const entry = await this.threads.forkThread(sourceThreadId, { cwd: optionalString(params.cwd) ?? undefined });
		this.attachThread(entry);
		this.subscribe(entry, connectionId(connection));
		const response = this.runtimeResponse(entry, true, sourceThreadId);
		this.notifications.broadcast({ method: "thread/started", params: { thread: response.thread } });
		return response;
	}

	private async read(request: RpcRequest): Promise<ThreadReadResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.threads.resumeThread(threadId);
		this.attachThread(entry);
		return { thread: buildWireThread(entry, this.turnLog, params.includeTurns === true) };
	}

	private async list(request: RpcRequest): Promise<ThreadListResponse> {
		const params = objectValue(request.params);
		const page = await this.threads.listThreads({
			cursor: optionalString(params.cursor) ?? null,
			limit: optionalNumber(params.limit) ?? undefined,
		});
		const archived = params.archived === true;
		const threads = archived ? this.archivedListThreads(page.threads) : page.threads;
		const filtered = threads.filter((thread) => this.archivedThreadIds.has(thread.id) === archived);
		return {
			data: filtered.map((thread) => buildWireThread(thread, this.turnLog, false)),
			nextCursor: page.nextCursor,
			backwardsCursor: null,
		};
	}

	private loadedList(request: RpcRequest): ThreadLoadedListResponse {
		const params = objectValue(request.params);
		const cursor = decodeCursor(optionalString(params.cursor) ?? null);
		const limit = optionalNumber(params.limit) ?? Number.POSITIVE_INFINITY;
		const ids = this.threads.listLoaded().map((thread) => thread.id);
		const data = ids.slice(cursor, cursor + limit);
		const nextOffset = cursor + data.length;
		return {
			data,
			nextCursor: nextOffset < ids.length ? encodeCursor(nextOffset) : null,
		};
	}

	private async setName(request: RpcRequest): Promise<Record<string, never>> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const name = requiredString(params.name, "name");
		const entry = await this.threads.resumeThread(threadId);
		entry.session.setSessionName(name);
		this.notifications.broadcast({ method: "thread/name/updated", params: { threadId, threadName: name } });
		return {};
	}

	private async archive(request: RpcRequest): Promise<Record<string, never>> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.threads.resumeThread(threadId);
		this.clearIdleTimer(threadId);
		this.archivedThreads.set(threadId, this.threads.buildThread(entry));
		entry.session.dispose();
		removeLoadedThread(this.threads, threadId);
		this.archivedThreadIds.add(threadId);
		this.notifications.broadcast({ method: "thread/archived", params: { threadId } });
		return {};
	}

	private async delete(request: RpcRequest): Promise<Record<string, never>> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		this.clearIdleTimer(threadId);
		await this.threads.deleteThread(threadId);
		this.archivedThreadIds.delete(threadId);
		this.archivedThreads.delete(threadId);
		this.notifications.broadcast({ method: "thread/deleted", params: { threadId } });
		return {};
	}

	private unsubscribe(connection: RegistryConnection, request: RpcRequest): ThreadUnsubscribeResponse {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch {
			return { status: "notLoaded" };
		}
		const id = connectionId(connection);
		if (!entry.subscribers.has(id)) {
			return { status: "notSubscribed" };
		}
		this.notifications.unsubscribe(threadId, id);
		this.scheduleIdleUnload(entry);
		return { status: "unsubscribed" };
	}

	private runtimeResponse(
		entry: ThreadEntry,
		includeTurns: boolean,
		forkedFromId: string | null = null,
	): RuntimeThreadResponse {
		const model = entry.session.model;
		const thread = buildWireThread(entry, this.turnLog, includeTurns, { forkedFromId });
		return {
			thread,
			model: model?.id ?? "unknown",
			modelProvider: model?.provider ?? "unknown",
			serviceTier: entry.session.serviceTier ?? null,
			cwd: entry.cwd,
			runtimeWorkspaceRoots: [entry.cwd],
			instructionSources: [],
			approvalPolicy: "never",
			approvalsReviewer: "user",
			sandbox: { type: "dangerFullAccess" },
			activePermissionProfile: null,
			reasoningEffort: entry.session.thinkingLevel ?? null,
			multiAgentMode: "explicitRequestOnly",
		};
	}

	private attachThread(entry: ThreadEntry): void {
		this.notifications.addThread(entry);
		this.clearIdleTimer(entry.id);
	}

	private subscribe(entry: ThreadEntry, connectionIdValue: string): void {
		this.notifications.subscribe(entry.id, connectionIdValue);
		this.replayPendingApprovals?.(entry.id, connectionIdValue);
	}

	private scheduleIdleUnload(entry: ThreadEntry): void {
		this.clearIdleTimer(entry.id);
		if (entry.subscribers.size > 0 || entry.activeTurn) {
			return;
		}
		const timer = setTimeout(() => this.unloadIfIdle(entry.id), this.idleUnloadMs);
		this.idleTimers.set(entry.id, timer);
	}

	private unloadIfIdle(threadId: string): void {
		this.clearIdleTimer(threadId);
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch {
			return;
		}
		if (entry.subscribers.size > 0 || entry.activeTurn) {
			return;
		}
		entry.session.dispose();
		removeLoadedThread(this.threads, threadId);
		this.notifications.broadcast({ method: "thread/closed", params: { threadId } });
		this.notifications.broadcast({
			method: "thread/status/changed",
			params: { threadId, status: NOT_LOADED_STATUS },
		});
	}

	private clearIdleTimer(threadId: string): void {
		const timer = this.idleTimers.get(threadId);
		if (!timer) {
			return;
		}
		clearTimeout(timer);
		this.idleTimers.delete(threadId);
	}

	private archivedListThreads(listedThreads: readonly WireThread[]): WireThread[] {
		const threadsById = new Map<string, WireThread>();
		for (const thread of listedThreads) {
			threadsById.set(thread.id, thread);
		}
		for (const thread of this.archivedThreads.values()) {
			threadsById.set(thread.id, thread);
		}
		return [...threadsById.values()];
	}
}
