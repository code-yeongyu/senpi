import { randomUUID } from "node:crypto";
import type {
	ThreadForkResponse,
	ThreadReadResponse,
	ThreadResumeResponse,
	ThreadStartResponse,
	ThreadUnarchiveResponse,
	ThreadUnsubscribeResponse,
} from "../protocol/index.ts";
import type { MethodHandler, MethodRegistry, RegistryConnection, RpcRequest } from "../rpc/registry.ts";
import type { NotificationRouter } from "../server/notifications.ts";
import { ThreadArchiveState } from "./archive-state.ts";
import { connectionId, objectValue, optionalString, requiredString } from "./handler-params.ts";
import { threadItemsListResponse, threadTurnsListResponse } from "./history.ts";
import { listThreadsResponse, loadedThreadsResponse } from "./list-handlers.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import { threadSearchResponse } from "./search.ts";
import { ThreadSearchCache } from "./search-cache.ts";
import { threadSearchOccurrencesResponse } from "./search-occurrences.ts";
import { requestedApprovalPolicy, requestedStartModel } from "./start-options.ts";
import type { TurnLog } from "./turn-log.ts";
import { invalidRequest } from "./turn-runtime.ts";
import { buildWireThread, NOT_LOADED_STATUS } from "./wire-thread.ts";

export interface ThreadLifecycleHandlersOptions {
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly notifications: NotificationRouter;
	readonly idleUnloadMinutes?: number;
	readonly replayPendingApprovals?: (threadId: string, connectionId: string) => void;
	readonly deferUntilResponded?: (connectionId: string, action: () => Promise<void> | void) => boolean;
}

type RuntimeThreadResponse = ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse;
type RuntimeResponseOptions = {
	readonly approvalPolicy?: ThreadStartResponse["approvalPolicy"];
	readonly forkedFromId?: string | null;
};

const DEFAULT_IDLE_UNLOAD_MINUTES = 30;

export interface ThreadLifecycleController {
	/** Schedules the idle-unload countdown for a thread whose last subscriber vanished (e.g. socket close). */
	scheduleIdleUnloadForThread(threadId: string): void;
	/** Clears every pending idle-unload timer; used during server shutdown. */
	dispose(): void;
}

export function registerThreadLifecycleHandlers(
	registry: MethodRegistry,
	options: ThreadLifecycleHandlersOptions,
): ThreadLifecycleController {
	const handlers = new ThreadLifecycleHandlers(options);
	for (const registration of handlers.registrations()) {
		registry.register(registration.method, {
			handler: registration.handler,
			scope: registration.method.startsWith("thread/") ? "thread" : "global",
			experimental: registration.experimental,
		});
	}
	return handlers;
}

type ThreadHandlerRegistration = {
	readonly method: string;
	readonly handler: MethodHandler;
	readonly experimental?: boolean;
};

class ThreadLifecycleHandlers {
	private readonly threads: ThreadRegistry;
	private readonly turnLog: TurnLog;
	private readonly notifications: NotificationRouter;
	private readonly replayPendingApprovals: ((threadId: string, connectionId: string) => void) | undefined;
	private readonly deferUntilResponded:
		| ((connectionId: string, action: () => Promise<void> | void) => boolean)
		| undefined;
	private readonly archiveState: ThreadArchiveState;
	private readonly searchCache = new ThreadSearchCache();
	private readonly idleUnloadMs: number;
	private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: ThreadLifecycleHandlersOptions) {
		this.threads = options.threads;
		this.turnLog = options.turnLog;
		this.notifications = options.notifications;
		this.replayPendingApprovals = options.replayPendingApprovals;
		this.deferUntilResponded = options.deferUntilResponded;
		this.archiveState = new ThreadArchiveState(options.threads.getSessionDir());
		this.idleUnloadMs = Math.max(0, options.idleUnloadMinutes ?? DEFAULT_IDLE_UNLOAD_MINUTES) * 60 * 1000;
	}

	registrations(): readonly ThreadHandlerRegistration[] {
		return [
			{
				method: "thread/start",
				handler: (context) => this.start(context.connection, context.request),
			},
			{
				method: "thread/resume",
				handler: (context) => this.resume(context.connection, context.request),
			},
			{
				method: "thread/fork",
				handler: (context) => this.fork(context.connection, context.request),
			},
			{ method: "thread/read", handler: (context) => this.read(context.request) },
			{
				method: "thread/list",
				handler: (context) =>
					listThreadsResponse(context.request.params, {
						threads: this.threads,
						turnLog: this.turnLog,
						archiveState: this.archiveState,
					}),
			},
			{
				method: "thread/loaded/list",
				handler: (context) => loadedThreadsResponse(context.request.params, this.threads),
			},
			{ method: "thread/name/set", handler: (context) => this.setName(context.request) },
			{ method: "thread/archive", handler: (context) => this.archive(context.request) },
			{
				method: "thread/unarchive",
				handler: (context) => this.unarchive(context.connection, context.request),
			},
			{ method: "thread/delete", handler: (context) => this.delete(context.request) },
			{
				method: "thread/unsubscribe",
				handler: (context) => this.unsubscribe(context.connection, context.request),
			},
			{
				method: "thread/search",
				experimental: true,
				handler: (context) =>
					threadSearchResponse(context.request.params, {
						threads: this.threads,
						turnLog: this.turnLog,
						archiveState: this.archiveState,
						cache: this.searchCache,
					}),
			},
			{
				method: "thread/searchOccurrences",
				experimental: true,
				handler: (context) =>
					threadSearchOccurrencesResponse(context.request.params, {
						archiveState: this.archiveState,
						threads: this.threads,
						turnLog: this.turnLog,
					}),
			},
			{
				method: "thread/turns/list",
				experimental: true,
				handler: (context) =>
					threadTurnsListResponse(context.request.params, {
						archiveState: this.archiveState,
						threads: this.threads,
						turnLog: this.turnLog,
					}),
			},
			{
				method: "thread/items/list",
				experimental: true,
				handler: (context) =>
					threadItemsListResponse(context.request.params, {
						archiveState: this.archiveState,
						threads: this.threads,
						turnLog: this.turnLog,
					}),
			},
			{
				method: "thread/compact/start",
				handler: (context) => this.compact(context.connection, context.request),
			},
		];
	}

	private async start(connection: RegistryConnection, request: RpcRequest): Promise<ThreadStartResponse> {
		const params = objectValue(request.params);
		const cwd = optionalString(params.cwd) ?? process.cwd();
		const entry = await this.threads.createThread({ cwd, model: requestedStartModel(params) });
		this.attachThread(entry);
		this.subscribe(entry, connectionId(connection));
		const response = await this.runtimeResponse(entry, false, { approvalPolicy: requestedApprovalPolicy(params) });
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
				...(await this.runtimeResponse(entry, true)),
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
		const response = await this.runtimeResponse(entry, true, { forkedFromId: sourceThreadId });
		this.notifications.broadcast({ method: "thread/started", params: { thread: response.thread } });
		return response;
	}

	private async read(request: RpcRequest): Promise<ThreadReadResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.threads.resumeThread(threadId);
		this.attachThread(entry);
		return { thread: await buildWireThread(entry, this.turnLog, params.includeTurns === true) };
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

	private compact(connection: RegistryConnection, request: RpcRequest): Record<string, never> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch (error) {
			if (error instanceof ThreadNotFoundError) {
				throw invalidRequest(`thread not found: ${threadId}`);
			}
			throw error;
		}

		const startCompaction = (): void => {
			const turnId = randomUUID();
			const item = { type: "contextCompaction", id: randomUUID() } as const;
			const startedAtMs = Date.now();
			this.turnLog.recordTurn(threadId, {
				turnId,
				startedAt: new Date(startedAtMs).toISOString(),
				status: "running",
			});
			this.notifications.toThread(threadId, {
				method: "item/started",
				params: { threadId, turnId, item, startedAtMs },
			});

			void entry.session.compact().then(
				() => this.completeCompaction(threadId, turnId, item),
				(error: unknown) =>
					this.turnLog.completeTurn(threadId, turnId, {
						status: "failed",
						completedAt: new Date().toISOString(),
						error: error instanceof Error ? error.message : String(error),
					}),
			);
		};
		if (this.deferUntilResponded?.(connectionId(connection), startCompaction) !== true) {
			startCompaction();
		}
		return {};
	}

	private completeCompaction(
		threadId: string,
		turnId: string,
		item: { readonly type: "contextCompaction"; readonly id: string },
	): void {
		const completedAtMs = Date.now();
		this.turnLog.appendItem(threadId, turnId, item);
		this.turnLog.completeTurn(threadId, turnId, {
			status: "completed",
			completedAt: new Date(completedAtMs).toISOString(),
		});
		this.notifications.toThread(threadId, {
			method: "item/completed",
			params: { threadId, turnId, item, completedAtMs },
		});
	}

	private async archive(request: RpcRequest): Promise<Record<string, never>> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.threads.resumeThread(threadId);
		this.clearIdleTimer(threadId);
		await this.archiveState.markArchived(this.threads.buildThread(entry));
		this.threads.unloadThread(threadId);
		this.notifications.removeThread(threadId);
		this.notifications.broadcast({ method: "thread/archived", params: { threadId } });
		return {};
	}

	private async delete(request: RpcRequest): Promise<Record<string, never>> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		this.clearIdleTimer(threadId);
		await this.archiveState.clearArchived(threadId);
		await this.threads.deleteThread(threadId);
		this.notifications.removeThread(threadId);
		this.notifications.broadcast({ method: "thread/deleted", params: { threadId } });
		return {};
	}

	private async unarchive(connection: RegistryConnection, request: RpcRequest): Promise<ThreadUnarchiveResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const archivedThread = await this.archiveState.unarchive(threadId);
		if (!archivedThread) {
			throw invalidRequest(`thread not found: ${threadId}`);
		}

		const wireThread = {
			...archivedThread,
			status: { type: "notLoaded" } as const,
		};
		const thread = await buildWireThread(wireThread, this.turnLog, false);
		const notify = (): void => {
			this.notifications.broadcast({ method: "thread/unarchived", params: { threadId } });
		};
		if (this.deferUntilResponded?.(connectionId(connection), notify) !== true) {
			notify();
		}
		return { thread };
	}

	private unsubscribe(connection: RegistryConnection, request: RpcRequest): ThreadUnsubscribeResponse {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch (error) {
			if (!(error instanceof ThreadNotFoundError)) {
				throw error;
			}
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

	scheduleIdleUnloadForThread(threadId: string): void {
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch (error) {
			if (!(error instanceof ThreadNotFoundError)) {
				throw error;
			}
			return;
		}
		this.scheduleIdleUnload(entry);
	}

	dispose(): void {
		for (const timer of this.idleTimers.values()) {
			clearTimeout(timer);
		}
		this.idleTimers.clear();
	}

	private async runtimeResponse(
		entry: ThreadEntry,
		includeTurns: boolean,
		options: RuntimeResponseOptions = {},
	): Promise<RuntimeThreadResponse> {
		const model = entry.session.model;
		const thread = await buildWireThread(entry, this.turnLog, includeTurns, {
			forkedFromId: options.forkedFromId ?? null,
		});
		return {
			thread,
			model: model?.id ?? "unknown",
			modelProvider: model?.provider ?? "unknown",
			serviceTier: entry.session.serviceTier ?? null,
			cwd: entry.cwd,
			runtimeWorkspaceRoots: [entry.cwd],
			instructionSources: [],
			approvalPolicy: options.approvalPolicy ?? "never",
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
		// An idle-unload countdown must never keep the process alive on its own
		// (graceful shutdown relies on the event loop draining).
		timer.unref();
		this.idleTimers.set(entry.id, timer);
	}

	private unloadIfIdle(threadId: string): void {
		this.clearIdleTimer(threadId);
		let entry: ThreadEntry;
		try {
			entry = this.threads.getLoadedThread(threadId);
		} catch (error) {
			if (!(error instanceof ThreadNotFoundError)) {
				throw error;
			}
			return;
		}
		if (entry.subscribers.size > 0 || entry.activeTurn) {
			return;
		}
		this.threads.unloadThread(threadId);
		this.notifications.removeThread(threadId);
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
}
