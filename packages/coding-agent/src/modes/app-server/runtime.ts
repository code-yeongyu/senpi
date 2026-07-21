import { ENV_SESSION_DIR, getAgentDir } from "../../config.ts";
import { getMcpService } from "../../core/extensions/builtin/mcp/service.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../core/sdk.ts";
import { createRegistry, type MethodRegistry } from "./rpc/registry.ts";
import { registerFuzzyFileSearchMethods } from "./search/fuzzy-search-methods.ts";
import { FuzzyFileSearchService } from "./search/fuzzy-search-service.ts";
import { ApprovalBridge, createAppServerUIContext } from "./server/approvals.ts";
import { NotificationRouter } from "./server/notifications.ts";
import type { ServerCore } from "./server/server-core.ts";
import { registerAppServerSkillMethods } from "./server/skills.ts";
import { connectionId } from "./threads/handler-params.ts";
import { registerThreadLifecycleHandlers, type ThreadLifecycleController } from "./threads/handlers.ts";
import { createMcpWireStatusAdapter, createProcessMcpWireStatusAdapter } from "./threads/mcp-wire-status.ts";
import { type AppServerSessionResult, ThreadNotFoundError, ThreadRegistry } from "./threads/registry.ts";
import { TurnLog } from "./threads/turn-log.ts";
import { createTurnEngine, type TurnEngineApi } from "./threads/turns.ts";
import {
	createModeTurnStore,
	createRoutedServerCore,
	registerLoadedThreadObjectListHandler,
	turnInterruptParams,
	turnStartParams,
	turnSteerParams,
} from "./turn-adapter.ts";

export type AppServerRuntime = {
	readonly core: ServerCore;
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly turns: TurnEngineApi;
	readonly dispose: () => void;
};

export function createAppServerRuntime(requestShutdown: (reason: string) => void): AppServerRuntime {
	const notifications = new NotificationRouter();
	const registry = createRegistry();
	const fuzzySearch = new FuzzyFileSearchService({
		broadcast: (notification) => notifications.broadcast(notification),
	});
	registerFuzzyFileSearchMethods(registry, fuzzySearch);
	let threads: ThreadRegistry;
	const processMcpWireStatusAdapter = createProcessMcpWireStatusAdapter({
		agentDir: getAgentDir(),
		cwd: process.cwd(),
		env: process.env,
	});
	const approvals = new ApprovalBridge((threadId, message) => {
		let subscriberCount = 0;
		try {
			subscriberCount = threads.getLoadedThread(threadId).subscribers.size;
		} catch (error: unknown) {
			if (error instanceof ThreadNotFoundError) {
				return 0;
			}
			throw error;
		}
		notifications.toThread(threadId, message);
		return subscriberCount;
	});
	let lifecycle: ThreadLifecycleController | undefined;
	threads = new ThreadRegistry({
		agentDir: getAgentDir(),
		sessionDir: process.env[ENV_SESSION_DIR],
		createSession: (options) => createBoundAppServerSession(options, approvals, notifications, requestShutdown),
		mcpWireStatusAdapter: processMcpWireStatusAdapter,
	});
	const core = createRoutedServerCore(
		registry,
		notifications,
		approvals,
		(threadId) => {
			lifecycle?.scheduleIdleUnloadForThread(threadId);
		},
		{
			codexHome: getAgentDir(),
			serverCwd: process.cwd(),
			threads,
		},
	);
	registerAppServerSkillMethods(registry, {
		agentDir: getAgentDir(),
		serverCwd: process.cwd(),
		threads,
		resourceLoaderFactory: async (cwd) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir() });
			await loader.reload();
			return loader;
		},
	});
	const turnLog = new TurnLog();
	const turns = createTurnEngine({
		store: createModeTurnStore(threads),
		turnLog,
		emitToThread: (threadId, notification) => notifications.toThread(threadId, notification),
		broadcast: (notification) => notifications.broadcast(notification),
	});
	registerTurnHandlers(registry, turns, core);

	lifecycle = registerThreadLifecycleHandlers(registry, {
		threads,
		turnLog,
		notifications,
		deferUntilResponded: (connectionId, action) => core.deferUntilResponded(connectionId, action),
		idleUnloadMinutes: 30,
		replayPendingApprovals: (threadId) => {
			approvals.replayPendingForThread(threadId);
		},
	});
	registerLoadedThreadObjectListHandler(registry, threads);

	return {
		core,
		threads,
		turnLog,
		turns,
		dispose: () => {
			fuzzySearch.dispose();
			lifecycle?.dispose();
		},
	};
}

async function createBoundAppServerSession(
	options: CreateAgentSessionOptions,
	approvals: ApprovalBridge,
	notifications: NotificationRouter,
	requestShutdown: (reason: string) => void,
): Promise<AppServerSessionResult> {
	const result = await createAgentSession(options);
	const threadId = result.session.sessionId;
	await result.session.bindExtensions({
		uiContext: createAppServerUIContext(approvals, threadId),
		mode: "app-server",
		shutdownHandler: () => requestShutdown("extension shutdown"),
		onError: (error) => {
			notifications.toThread(threadId, { method: "error", params: error });
		},
	});
	// The MCP service captures this session's attach state under its session id.
	// Convert that captured state into a session-owned adapter before the entry is
	// registered; later requests never consult the service-global lifecycle view.
	const mcpService = getMcpService();
	const mcpWireStatusAdapter = createMcpWireStatusAdapter(mcpService.getWireStatusSnapshot(threadId));
	result.session.subscribe((event) => {
		if (event.type === "agent_end") {
			approvals.cancelPendingForThread(threadId);
		}
	});
	return { ...result, mcpWireStatusAdapter };
}

function registerTurnHandlers(registry: MethodRegistry, turns: TurnEngineApi, core: ServerCore): void {
	const deferForResponse = async <T>(
		connection: Parameters<MethodRegistry["dispatch"]>[0],
		run: (defer: (action: () => void) => boolean) => Promise<T>,
	): Promise<T> => {
		const actions: Array<() => void> = [];
		const result = await run((action) => {
			actions.push(action);
			return true;
		});
		for (const action of actions) core.deferUntilResponded(connectionId(connection), action);
		return result;
	};
	registry.register("turn/start", {
		scope: "thread",
		handler: (context) =>
			deferForResponse(context.connection, (defer) => turns.startTurn(turnStartParams(context.request), defer)),
	});
	registry.register("turn/steer", {
		scope: "thread",
		handler: (context) => turns.steerTurn(turnSteerParams(context.request)),
	});
	registry.register("turn/interrupt", {
		scope: "thread",
		handler: (context) =>
			deferForResponse(context.connection, (defer) =>
				turns.interruptTurn(turnInterruptParams(context.request), defer),
			),
	});
}
