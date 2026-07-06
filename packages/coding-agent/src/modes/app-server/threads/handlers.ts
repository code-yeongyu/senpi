import type {
	ThreadForkResponse,
	ThreadReadResponse,
	ThreadResumeResponse,
	ThreadStartResponse,
	ThreadUnsubscribeResponse,
} from "../protocol/generated/v2/index.ts";
import type { MethodRegistry, RegistryConnection, RpcRequest } from "../rpc/registry.ts";
import type { NotificationRouter } from "../server/notifications.ts";
import { ThreadArchiveState } from "./archive-state.ts";
import { connectionId, objectValue, optionalString, requiredString } from "./handler-params.ts";
import { listThreadsResponse, loadedThreadsResponse } from "./list-handlers.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import { requestedApprovalPolicy, requestedStartModel } from "./start-options.ts";
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
	for (const [method, handler] of handlers.registrations()) {
		registry.register(method, { handler, scope: method.startsWith("thread/") ? "thread" : "global" });
	}
	return handlers;
}

class ThreadLifecycleHandlers {
	private readonly threads: ThreadRegistry;
	private readonly turnLog: TurnLog;
	private readonly notifications: NotificationRouter;
	private readonly replayPendingApprovals: ((threadId: string, connectionId: string) => void) | undefined;
	private readonly archiveState: ThreadArchiveState;
	private readonly idleUnloadMs: number;
	private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: ThreadLifecycleHandlersOptions) {
		this.threads = options.threads;
		this.turnLog = options.turnLog;
		this.notifications = options.notifications;
		this.replayPendingApprovals = options.replayPendingApprovals;
		this.archiveState = new ThreadArchiveState(options.threads.getSessionDir());
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
			[
				"thread/list",
				(context) =>
					listThreadsResponse(context.request.params, {
						threads: this.threads,
						turnLog: this.turnLog,
						archiveState: this.archiveState,
					}),
			],
			["thread/loaded/list", (context) => loadedThreadsResponse(context.request.params, this.threads)],
			["thread/name/set", (context) => this.setName(context.request)],
			["thread/archive", (context) => this.archive(context.request)],
			["thread/delete", (context) => this.delete(context.request)],
			["thread/unsubscribe", (context) => this.unsubscribe(context.connection, context.request)],
		];
	}

	private async start(connection: RegistryConnection, request: RpcRequest): Promise<ThreadStartResponse> {
		const params = objectValue(request.params);
		const cwd = optionalString(params.cwd) ?? process.cwd();
		const entry = await this.threads.createThread({ cwd, model: requestedStartModel(params) });
		this.attachThread(entry);
		this.subscribe(entry, connectionId(connection));
		const response = this.runtimeResponse(entry, false, { approvalPolicy: requestedApprovalPolicy(params) });
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
		const response = this.runtimeResponse(entry, true, { forkedFromId: sourceThreadId });
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

	private runtimeResponse(
		entry: ThreadEntry,
		includeTurns: boolean,
		options: RuntimeResponseOptions = {},
	): RuntimeThreadResponse {
		const model = entry.session.model;
		const thread = buildWireThread(entry, this.turnLog, includeTurns, { forkedFromId: options.forkedFromId ?? null });
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
