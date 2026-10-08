import { ENV_SESSION_DIR, getAgentDir } from "../../config.ts";
import { getMcpService } from "../../core/extensions/builtin/mcp/service.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../core/sdk.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { RpcNotification } from "./rpc/envelope.ts";
import { createRegistry, type MethodRegistry, registerExtensionRequestMethod } from "./rpc/registry.ts";
import { registerFuzzyFileSearchMethods } from "./search/fuzzy-search-methods.ts";
import { FuzzyFileSearchService } from "./search/fuzzy-search-service.ts";
import { ApprovalBridge, createAppServerUIContext } from "./server/approvals.ts";
import { NotificationRouter, type RouterOutboundMessage } from "./server/notifications.ts";
import type { ServerCore } from "./server/server-core.ts";
import { registerAppServerSkillMethods } from "./server/skills.ts";
import { UserInputBridge } from "./server/user-input-bridge.ts";
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

export interface AppServerRuntimeOptions {
	/** Resolved `--extension` sources, loaded into every thread session and every skills/list loader. */
	readonly extensionPaths?: readonly string[];
}

export function createAppServerRuntime(
	requestShutdown: (reason: string) => void,
	runtimeOptions: AppServerRuntimeOptions = {},
): AppServerRuntime {
	const additionalExtensionPaths = [...(runtimeOptions.extensionPaths ?? [])];
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
	const sendToSubscribers = (threadId: string, message: RouterOutboundMessage): number => {
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
	};
	const approvals = new ApprovalBridge(sendToSubscribers);
	const userInput = new UserInputBridge(sendToSubscribers);
	let lifecycle: ThreadLifecycleController | undefined;
	threads = new ThreadRegistry({
		agentDir: getAgentDir(),
		sessionDir: process.env[ENV_SESSION_DIR],
		createSession: async (options) =>
			createBoundAppServerSession(
				await withExtensionPaths(options, additionalExtensionPaths),
				approvals,
				notifications,
				requestShutdown,
				userInput,
				(threadId) => {
					try {
						return threads.getLoadedThread(threadId).activeTurn?.turnId ?? "turn-user-input";
					} catch (error) {
						if (error instanceof ThreadNotFoundError) return "turn-user-input";
						throw error;
					}
				},
			),
		mcpWireStatusAdapter: processMcpWireStatusAdapter,
	});
	registerExtensionRequestMethod(registry, (threadId) => threads.getLoadedThread(threadId).session);
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
		userInput,
	);
	registerAppServerSkillMethods(registry, {
		agentDir: getAgentDir(),
		serverCwd: process.cwd(),
		threads,
		resourceLoaderFactory: async (cwd) => {
			const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), additionalExtensionPaths });
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
		observeThread: (threadId) => turns.observeThread(threadId),
		idleUnloadMinutes: 30,
		replayPendingApprovals: (threadId) => {
			approvals.replayPendingForThread(threadId);
			userInput.replayPendingForThread(threadId);
		},
	});
	registerLoadedThreadObjectListHandler(registry, threads);

	return {
		core,
		threads,
		turnLog,
		turns,
		dispose: () => {
			for (const thread of threads.listLoaded()) userInput.cancelPendingForThread(thread.id);
			fuzzySearch.dispose();
			lifecycle?.dispose();
		},
	};
}

/**
 * A session's default resource loader only discovers settings and agent-dir extensions, so explicit
 * paths need a loader of their own, built the way `createAgentSession` builds its default one.
 */
async function withExtensionPaths(
	options: CreateAgentSessionOptions,
	additionalExtensionPaths: string[],
): Promise<CreateAgentSessionOptions> {
	if (additionalExtensionPaths.length === 0 || options.resourceLoader) return options;
	const cwd = options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths });
	await resourceLoader.reload();
	return { ...options, settingsManager, resourceLoader };
}

async function createBoundAppServerSession(
	options: CreateAgentSessionOptions,
	approvals: ApprovalBridge,
	notifications: NotificationRouter,
	requestShutdown: (reason: string) => void,
	userInput: UserInputBridge,
	getTurnId: (threadId: string) => string,
): Promise<AppServerSessionResult> {
	const result = await createAgentSession(options);
	const threadId = result.session.sessionId;
	const initialNotifications: RpcNotification[] = [];
	let bindingExtensions = true;
	result.session.extensionRunner.onRpcEvent(({ name, data }) => {
		const notification = {
			method: "extension_event",
			params: { type: "extension_event", name, data, threadId },
		};
		if (bindingExtensions) {
			initialNotifications.push(notification);
			return;
		}
		notifications.toThread(threadId, notification);
	});
	await result.session.bindExtensions({
		uiContext: createAppServerUIContext(approvals, threadId, userInput, () => getTurnId(threadId)),
		mode: "app-server",
		shutdownHandler: () => requestShutdown("extension shutdown"),
		onError: (error) => {
			notifications.toThread(threadId, { method: "error", params: error });
		},
	});
	bindingExtensions = false;
	// The MCP service captures this session's attach state under its session id.
	// Convert that captured state into a session-owned adapter before the entry is
	// registered; later requests never consult the service-global lifecycle view.
	const mcpService = getMcpService();
	const mcpWireStatusAdapter = createMcpWireStatusAdapter(mcpService.getWireStatusSnapshot(threadId));
	// Attach is started by session_start but no longer awaited by it, so the snapshot above is
	// empty whenever a server is still booting. Take later inventories by subscription rather
	// than by reading the service per request, which stays within this adapter's contract.
	mcpWireStatusAdapter.bindLiveUpdates(
		mcpService.onWireStatusChanged((sessionId, snapshot) => {
			if (sessionId === threadId) mcpWireStatusAdapter.update(snapshot);
		}),
	);
	result.session.subscribe((event) => {
		if (event.type === "agent_end") {
			approvals.cancelPendingForThread(threadId);
			userInput.cancelPendingForThread(threadId, { blockingOnly: true });
		}
	});
	return { ...result, initialNotifications, mcpWireStatusAdapter };
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
