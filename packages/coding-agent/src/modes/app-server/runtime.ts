import { ENV_SESSION_DIR, getAgentDir } from "../../config.ts";
import { getMcpService } from "../../core/extensions/builtin/mcp/service.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../core/sdk.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	type AppServerConfigOverride,
	type AppServerMcpConfigSource,
	materializeAppServerMcpConfigSource,
} from "./mcp-config-overrides.ts";
import type { RpcNotification } from "./rpc/envelope.ts";
import { createRegistry, type MethodRegistry, registerExtensionRequestMethod } from "./rpc/registry.ts";
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

export function createAppServerRuntime(
	requestShutdown: (reason: string) => void,
	options: { readonly configOverrides?: readonly AppServerConfigOverride[] } = {},
): AppServerRuntime {
	const notifications = new NotificationRouter();
	const mcpConfigSource = materializeAppServerMcpConfigSource(options.configOverrides ?? []);
	const registry = createRegistry();
	const fuzzySearch = new FuzzyFileSearchService({
		broadcast: (notification) => notifications.broadcast(notification),
	});
	registerFuzzyFileSearchMethods(registry, fuzzySearch);
	let threads: ThreadRegistry;
	const processMcpWireStatusAdapter = createProcessMcpWireStatusAdapter({
		additionalServers: mcpConfigSource.servers,
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
		createSession: (sessionOptions) =>
			createBoundAppServerSession(sessionOptions, {
				approvals,
				mcpConfigSource,
				notifications,
				requestShutdown,
			}),
		mcpWireStatusAdapter: processMcpWireStatusAdapter,
	});
	registerMcpReloadMethod(registry, threads);
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
		observeThread: (threadId) => turns.observeThread(threadId),
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

type AppServerSessionBindings = {
	readonly approvals: ApprovalBridge;
	readonly mcpConfigSource: AppServerMcpConfigSource;
	readonly notifications: NotificationRouter;
	readonly requestShutdown: (reason: string) => void;
};

async function createBoundAppServerSession(
	options: CreateAgentSessionOptions,
	bindings: AppServerSessionBindings,
): Promise<AppServerSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [...bindings.mcpConfigSource.extensionFactories],
		settingsManager,
	});
	await resourceLoader.reload();
	const result = await createAgentSession({ ...options, resourceLoader, settingsManager });
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
		bindings.notifications.toThread(threadId, notification);
	});
	await result.session.bindExtensions({
		uiContext: createAppServerUIContext(bindings.approvals, threadId),
		mode: "app-server",
		shutdownHandler: () => bindings.requestShutdown("extension shutdown"),
		onError: (error) => {
			bindings.notifications.toThread(threadId, { method: "error", params: error });
		},
	});
	bindingExtensions = false;
	// The MCP service captures this session's attach state under its session id.
	// Convert that captured state into a session-owned adapter before the entry is
	// registered; later requests never consult the service-global lifecycle view.
	const mcpService = getMcpService();
	const mcpWireStatusAdapter = createMcpWireStatusAdapter(mcpService.getWireStatusSnapshot(threadId));
	result.session.subscribe((event) => {
		if (event.type === "agent_end") {
			bindings.approvals.cancelPendingForThread(threadId);
		}
	});
	return { ...result, initialNotifications, mcpWireStatusAdapter };
}

function registerMcpReloadMethod(registry: MethodRegistry, threads: ThreadRegistry): void {
	registry.register("config/mcpServer/reload", {
		scope: "global",
		handler: async () => {
			const service = getMcpService();
			for (const thread of threads.listLoaded()) {
				const entry = threads.getLoadedThread(thread.id);
				entry.mcpWireStatusAdapter?.update(await service.reloadSession(thread.id));
			}
			return {};
		},
	});
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
