/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import { basename } from "node:path";
import type { ExtensionRpcRequestContext } from "./rpc-context.ts";
import { requestExtensionRpc } from "./rpc-request.ts";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { DiscoveredResourceEntry } from "../discovered-resource-scope.ts";
import type { DynamicSystemPromptPart } from "../dynamic-prompt/build.ts";
import { createEventBus, type EventBus, EXTENSION_RPC_EVENT_CHANNEL, type ExtensionRpcEvent } from "../event-bus.ts";
import { type InputOrigin, inputAttributionOf, inputOriginOf } from "../input-origin.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import { inheritMcpMrtrPresentation } from "../mcp-mrtr-presentations.ts";
import type { NamedMemoryReporter } from "../memory-report/memory-report-registry.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import { bindQuestionInput } from "../question-input.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	DEFAULT_EXTENSION_EVENT_HANDLER_TIMEOUT_MS,
	DEFAULT_EXTENSION_EVENT_HANDLER_WARN_MS,
	DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	DEFAULT_SESSION_SHUTDOWN_HANDLER_WARN_MS,
	DEFAULT_SESSION_SHUTDOWN_QUIT_BUDGET_MS,
	SettingsManager,
} from "../settings-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { VirtualModelDefinition } from "../virtual-models.ts";
import { goalFilePath } from "./builtin/goal/persistence.ts";
import { goalStoreRef } from "./builtin/goal/store-ref.ts";
import { disableServerSearch } from "./builtin/server-search-fallback.ts";
import { dispatchContextMessages } from "./context-dispatch.ts";
import { reclaimRunnerHandles, registerRunnerExtensions } from "./extension-handle-ledger.ts";
import {
	type BudgetedSequence,
	type ExtensionHandlerBudget,
	type ExtensionHandlerStall,
	type HandlerStopVerdict,
	HeldHandlerWaits,
	runBudgetedHandler,
	runBudgetedSequence,
} from "./handler-budget.ts";
import { type ExtensionKernelTools, kernelToolInvokerStorage, kernelToolsStorage } from "./kernel-tools-context.ts";
import { drainPendingProviderRegistrations } from "./loader.ts";
import { runSessionMoveHandlers, type SessionMoveEmission, type SessionMoveFailure } from "./session-move-emit.ts";
import { SessionStartTurnGate } from "./session-start-turn-gate.ts";
import { QuitDeadline, type QuitHandlerBudget, type SessionShutdownBudget } from "./shutdown-quit-budget.ts";
import { StaleExtensionContextError } from "./stale-context-error.ts";
import type {
	AgentBeforeSettleEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	BoundaryResult,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	ContextWithSystemEvent,
	EntryRenderer,
	EntryRendererOptions,
	ExecuteToolOptions,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionToolContext,
	ExtensionUIContext,
	InputAttribution,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ModelSelectEvent,
	ModelSelectEventResult,
	OffloadOptions,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProviderLoginStartEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	ProviderRequestPreparation,
	RegisteredChildModule,
	RegisteredCommand,
	RegisteredMcpServerDeclaration,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourceDiscoverEntry,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageReceipt,
	ServiceTier,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeReloadResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
	UIPromptKind,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";
import { RUNTIME_EXTENSION_PATH } from "./types.ts";

export { ExtensionRpcRequestNotFoundError } from "./rpc-request.ts";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

function isUserBashEventResult(value: unknown): value is UserBashEventResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const hasOperations = candidate.operations !== undefined;
	const hasResult = candidate.result !== undefined;
	if (hasOperations === hasResult) return false;

	if (hasOperations) {
		const operations = candidate.operations;
		if (typeof operations !== "object" || operations === null) return false;
		return typeof (operations as Record<string, unknown>).exec === "function";
	}

	const result = candidate.result;
	if (typeof result !== "object" || result === null) return false;
	const resultRecord = result as Record<string, unknown>;
	return (
		typeof resultRecord.output === "string" &&
		"exitCode" in resultRecord &&
		(resultRecord.exitCode === undefined || typeof resultRecord.exitCode === "number") &&
		typeof resultRecord.cancelled === "boolean" &&
		typeof resultRecord.truncated === "boolean" &&
		(resultRecord.fullOutputPath === undefined || typeof resultRecord.fullOutputPath === "string")
	);
}

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| ContextWithSystemEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| ModelSelectEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| TurnEndEvent
	| AgentBeforeSettleEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{
		type:
			| "session_before_switch"
			| "session_before_fork"
			| "session_before_reload"
			| "session_before_compact"
			| "session_before_tree";
	}
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeReloadResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_reload" }
			? SessionBeforeReloadResult | undefined
			: TEvent extends { type: "session_before_compact" }
				? SessionBeforeCompactResult | undefined
				: TEvent extends { type: "session_before_tree" }
					? SessionBeforeTreeResult | undefined
					: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

function boundedToolHookStatusMessage(message: string): string {
	return message.length <= 79 ? message : `${message.slice(0, 76)}...`;
}

function sanitizedToolHookStatusMessage(message: string): string {
	return boundedToolHookStatusMessage(
		stripAnsi(message)
			.replace(/[\r\n\t]+/g, " ")
			.replace(/[\u0000-\u001f\u007f]+/g, "")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

export type ExtensionToolHookName = "PreToolUse" | "PostToolUse";
export type ExtensionToolHookLifecycleStatus = "completed" | "blocked" | "failed";

type ExtensionToolHookLifecycleEventBase = {
	type: "tool_hook_status";
	hookRunId: string;
	hookName: ExtensionToolHookName;
	toolName: string;
	toolCallId: string;
	extensionPath: string;
	statusMessage: string;
	startedAt: number;
};

export type ExtensionToolHookLifecycleEvent =
	| (ExtensionToolHookLifecycleEventBase & {
			phase: "start";
	  })
	| (ExtensionToolHookLifecycleEventBase & {
			phase: "update";
	  })
	| (ExtensionToolHookLifecycleEventBase & {
			phase: "end";
			completedAt: number;
			status: ExtensionToolHookLifecycleStatus;
			errorMessage?: string;
	  });

export type ExtensionToolHookLifecycleObserver = (event: ExtensionToolHookLifecycleEvent) => void;

type BoundaryBaseEvent =
	| Omit<TurnEndEvent, "entries" | "continue" | "context">
	| Omit<AgentBeforeSettleEvent, "entries" | "continue" | "context">;

interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = ExtensionCommandContextActions["navigateTree"];

export type EditUserMessageHandler = ExtensionCommandContextActions["editUserMessage"];

export type EditAssistantMessageHandler = (
	entryId: string,
	text: string,
	options?: { summarize?: boolean; customInstructions?: string; expectedLeafId?: string },
) => Promise<{ cancelled: boolean; unchanged?: boolean; entryId?: string }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Agent lifecycle events the session awaits on its serial event queue before it persists a turn (senpi#3650).
 * Their handlers observe; none may hold the queue indefinitely, so each runs under the host's event handler budget.
 */
const QUEUED_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const UNBOUNDED_HANDLER_BUDGET: ExtensionHandlerBudget = { warnMs: 0, timeoutMs: 0 };

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 *
 * Each handler runs under the host's shutdown budget (see
 * `ExtensionRunner.emit`), so a hung extension cannot hold teardown hostage.
 * Afterwards senpi closes the servers, sockets and timers an extension instance
 * still holds open (senpi#2292), with or without handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
	options: { readonly processExit?: boolean } = {},
): Promise<boolean> {
	if (options.processExit && event.reason === "quit") extensionRunner.armProcessExitBudget();
	const emitted = extensionRunner.hasHandlers("session_shutdown");
	if (emitted) await extensionRunner.emit(event);
	reclaimRunnerHandles(extensionRunner);
	return emitted;
}

function snapshotEventHandlers(extensions: Extension[], event: ExtensionEvent["type"]) {
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

type EventHandlerFn = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];
interface HandlerEntry {
	readonly path: string;
	readonly handler: EventHandlerFn;
}

/** The same snapshot as `snapshotEventHandlers`, in dispatch order, one entry per handler. */
function flattenHandlers(extensions: Extension[], event: ExtensionEvent["type"]): readonly HandlerEntry[] {
	return snapshotEventHandlers(extensions, event).flatMap(({ ext, handlers }) =>
		handlers.map((handler) => ({ path: ext.path, handler })),
	);
}

function entryAt(entries: readonly HandlerEntry[], index: number): HandlerEntry {
	const entry = entries[index];
	if (entry === undefined) throw new RangeError(`no extension handler at index ${index}`);
	return entry;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const { ext, handlers } of snapshotEventHandlers(extensionsResult.extensions, "project_trust")) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

function createNoOpSessionSettings(): ExtensionContextActions["sessionSettings"] {
	const settings = SettingsManager.inMemory();
	return {
		getRetryFallbackSettings: () => settings.getRetryFallbackSettings(),
		setFallbackChain: async (key, entries) => {
			settings.setFallbackChain(key, [...entries]);
			await settings.flush();
		},
		removeFallbackChain: async (key) => {
			settings.removeFallbackChain(key);
			await settings.flush();
		},
		setModelFallbackEnabled: async (enabled) => {
			settings.setModelFallbackEnabled(enabled);
			await settings.flush();
		},
		setFallbackRevertPolicy: async (policy) => {
			settings.setFallbackRevertPolicy(policy);
			await settings.flush();
		},
		reload: () => settings.reload(),
		getFallbackStatus: () => undefined,
	};
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setSubagentCost: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

export class ExtensionRunner {
	private extensions: Extension[];
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private eventBus: EventBus;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private eventHandlerBudget: () => ExtensionHandlerBudget = () => UNBOUNDED_HANDLER_BUDGET;
	private handlerStallListener: ((stall: ExtensionHandlerStall) => void) | undefined;
	private handlerTurnScope: () => number = () => 0;
	private reportedInvalidHandlerBudget = false;
	private processExitRequestedAt: number | undefined;
	private readonly heldHandlerWaits = new HeldHandlerWaits();
	private getModel: () => Model<any> | undefined = () => undefined;
	private getServiceTier: () => ServiceTier | undefined = () => undefined;
	private getEffectiveServiceTier: () => ServiceTier | undefined = () => this.getServiceTier();
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private engineTurnsHeldFn: () => boolean = () => false;
	private noteHeldWakeFn: (source: string) => void = () => {};
	private pauseActions: Pick<ExtensionContextActions, "getPauseState" | "fenceRun" | "releaseRunFence"> = {};
	private questionInput: ExtensionContextActions["questionInput"];
	private personAnswerPending = false;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: ExtensionContextActions["abort"] = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private hasQueuedPersonInputFn: () => boolean = () => false;
	private isCompactingFn: () => boolean = () => false;
	private checkReloadVetoFn: ExtensionContextActions["checkReloadVeto"];
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private getCompactionModelFn: ExtensionContextActions["getCompactionModel"];
	private getCompactionSettingsFn: ExtensionContextActions["getCompactionSettings"] = () => ({
		enabled: true,
		reserveTokens: 16384,
		keepRecentTokens: 20000,
	});
	private getPromptCacheSafeWaitSecondsFn: () => number | undefined = () => undefined;
	private getPromptCacheGoalBackstopMaxSecondsFn: () => number = () => 270;
	private getPromptCacheKeepAliveSettingsFn: NonNullable<ExtensionContextActions["getPromptCacheKeepAliveSettings"]> =
		() => ({ enabled: false, maxRequestsPerSession: 3, maxCostUsdPerSession: 0.05, marginSeconds: 60 });
	private getLookAtSettingsFn: ExtensionContextActions["getLookAtSettings"] = () => ({
		enabled: true,
		models: undefined,
	});
	private getAskUserSettingsFn: () => { enabled: boolean; timeoutMinutes: number } = () => ({
		enabled: true,
		timeoutMinutes: 30,
	});
	private getBrowserEngineFn: NonNullable<ExtensionContextActions["getBrowserEngine"]> = () => undefined;
	private getSessionEnvFn: NonNullable<ExtensionContextActions["getSessionEnv"]> = () => undefined;
	private getImageSettingsFn: ExtensionContextActions["getImageSettings"] = () => ({
		autoResize: true,
		blockImages: false,
	});
	private sessionSettingsFn: ExtensionContextActions["sessionSettings"] = createNoOpSessionSettings();
	private compactFn: (options?: CompactOptions) => void = () => {};
	private beginCompactionFn: ExtensionContextActions["beginCompaction"] = undefined;
	private updateCompactionFn: ExtensionContextActions["updateCompaction"] = undefined;
	private endCompactionFn: ExtensionContextActions["endCompaction"] = undefined;
	private getMessageRevisionFn: () => number = () => 0;
	private applyCompactionFn: ExtensionContextActions["applyCompaction"] = async () => ({
		applied: false,
		reason: "rejected",
	});
	private getSystemPromptFn: () => string = () => "";
	private getLoadedHookSourcesFn: ExtensionContextActions["getLoadedHookSources"] = () => ({
		agentDir: "",
		cwd: this.cwd,
		globalHookSourcePaths: [],
		globalHooksPath: "",
		preSessionHookSourcePaths: [],
		projectHookSourcePaths: [],
		projectHooksPath: "",
		runtimeHookSourcePaths: [],
	});
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private getPromptCachePrefixRequestFn: ExtensionContextActions["getPromptCachePrefixRequest"] = undefined;
	private onUserActivityFn: ExtensionContextActions["onUserActivity"];
	private getAgentDirFn: () => string = () => getAgentDir();
	private executeToolFn: ExtensionContextActions["executeTool"];
	private offloadFn: ExtensionContextActions["offload"];
	private getCallableToolsFn: () => readonly AgentTool[] = () => [];
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private editAssistantMessageHandler: EditAssistantMessageHandler = async () => ({ cancelled: false });
	private editUserMessageHandler: EditUserMessageHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler | undefined;
	private reloadRequestPromise: Promise<void> | undefined;
	private shutdownHandler: ShutdownHandler = () => {};
	private readonly sessionStartTurns = new SessionStartTurnGate((error) =>
		this.emitError({
			extensionPath: RUNTIME_EXTENSION_PATH,
			event: "session_start",
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private toolHookLifecycleObserver: ExtensionToolHookLifecycleObserver | undefined;
	private nextToolHookRunIndex = 0;
	private uiPromptDepth = 0;
	private activeUIPrompt: { kind: UIPromptKind; title?: string; requestId: string; since: string } | undefined;
	private lifecycleAttentionObserver: (() => void) | undefined;

	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		eventBus: EventBus = createEventBus(),
	) {
		this.extensions = extensions;
		registerRunnerExtensions(this, extensions);
		this.runtime = runtime;
		runtime.mcpServers.bind(extensions);
		runtime.emitProviderLoginStart = (event) => this.emitProviderLoginStart(event);
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
		this.eventBus = eventBus;
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig, extensionPath?: string) => void;
			registerNativeProvider?: (provider: Provider, extensionPath?: string) => void;
			unregisterProvider?: (name: string) => void;
			registerVirtualModel?: (definition: VirtualModelDefinition) => void;
			unregisterVirtualModel?: (provider: string, id: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		if (actions.lifecycle) this.runtime.lifecycle = actions.lifecycle;
		this.runtime.sendMessage = (message, options) => {
			if (options?.triggerTurn === true) this.sessionStartTurns.admit(() => actions.sendMessage(message, options));
			else actions.sendMessage(message, options);
		};
		// An itemized send answers its receipts from wherever its admission ends up running (senpi#3811).
		this.runtime.sendItemizedMessage = (message, options) => {
			const receipts = Promise.withResolvers<readonly SendMessageReceipt[] | undefined>();
			const send = () => {
				const itemized = actions.sendItemizedMessage;
				if (itemized === undefined) {
					actions.sendMessage(message, options);
					receipts.resolve(undefined);
				} else itemized(message, options).then(receipts.resolve, receipts.reject);
			};
			if (options.triggerTurn === true) this.sessionStartTurns.admit(send);
			else send();
			return receipts.promise;
		};
		this.runtime.sendUserMessage = (content, options) => {
			// Captured at admission: a deferred answer keeps the origin it was delivered with.
			const inputOrigin: InputOrigin = this.personAnswerPending ? "person" : "extension";
			this.personAnswerPending = false;
			this.sessionStartTurns.admit(() => actions.sendUserMessage(content, options, inputOrigin));
		};
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.executeTool = actions.executeTool;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.getSettings = actions.getSettings;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.registerRemovedToolHint = actions.registerRemovedToolHint;
		this.runtime.registerLazyToolActivator = actions.registerLazyToolActivator;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.setSessionModel = actions.setSessionModel;
		this.runtime.setSessionThinkingLevel = actions.setSessionThinkingLevel;
		this.runtime.setSessionFastMode = actions.setSessionFastMode;
		if (actions.sessionControl) this.runtime.sessionControl = actions.sessionControl;
		if (actions.armToolBarrier) this.runtime.armToolBarrier = actions.armToolBarrier;
		if (actions.releaseToolBarrier) this.runtime.releaseToolBarrier = actions.releaseToolBarrier;
		this.runtime.createContext = () => this.createContext();

		this.offloadFn = contextActions.offload;
		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.getServiceTier = contextActions.getServiceTier;
		this.getEffectiveServiceTier = contextActions.getEffectiveServiceTier ?? contextActions.getServiceTier;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.engineTurnsHeldFn = contextActions.engineTurnsHeld ?? (() => false);
		this.noteHeldWakeFn = contextActions.noteHeldWake ?? (() => {});
		this.pauseActions = {
			getPauseState: contextActions.getPauseState,
			fenceRun: contextActions.fenceRun,
			releaseRunFence: contextActions.releaseRunFence,
		};
		this.questionInput = contextActions.questionInput;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.hasQueuedPersonInputFn = contextActions.hasQueuedPersonInput ?? (() => false);
		this.isCompactingFn = contextActions.isCompacting;
		this.checkReloadVetoFn = contextActions.checkReloadVeto;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.getCompactionSettingsFn = contextActions.getCompactionSettings;
		this.getCompactionModelFn = contextActions.getCompactionModel;
		if (contextActions.getPromptCacheSafeWaitSeconds)
			this.getPromptCacheSafeWaitSecondsFn = contextActions.getPromptCacheSafeWaitSeconds;
		if (contextActions.getPromptCacheGoalBackstopMaxSeconds)
			this.getPromptCacheGoalBackstopMaxSecondsFn = contextActions.getPromptCacheGoalBackstopMaxSeconds;
		if (contextActions.getPromptCacheKeepAliveSettings)
			this.getPromptCacheKeepAliveSettingsFn = contextActions.getPromptCacheKeepAliveSettings;
		this.getLookAtSettingsFn = contextActions.getLookAtSettings;
		if (contextActions.getAskUserSettings) this.getAskUserSettingsFn = contextActions.getAskUserSettings;
		if (contextActions.getBrowserEngine) this.getBrowserEngineFn = contextActions.getBrowserEngine;
		if (contextActions.getSessionEnv) this.getSessionEnvFn = contextActions.getSessionEnv;
		this.getImageSettingsFn = contextActions.getImageSettings;
		this.sessionSettingsFn = contextActions.sessionSettings;
		this.compactFn = contextActions.compact;
		this.beginCompactionFn = contextActions.beginCompaction;
		this.updateCompactionFn = contextActions.updateCompaction;
		this.endCompactionFn = contextActions.endCompaction;
		this.getMessageRevisionFn = contextActions.getMessageRevision;
		this.applyCompactionFn = contextActions.applyCompaction;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getLoadedHookSourcesFn = contextActions.getLoadedHookSources;
		if (contextActions.getAgentDir) this.getAgentDirFn = contextActions.getAgentDir;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));
		this.getPromptCachePrefixRequestFn = contextActions.getPromptCachePrefixRequest;
		this.onUserActivityFn = contextActions.onUserActivity;
		this.executeToolFn = contextActions.executeTool;
		this.getCallableToolsFn = contextActions.getCallableTools ?? (() => []);
		// Servers registered from now on reach the extension that connects them right away. Servers
		// registered during loading are read on session_start.
		this.runtime.mcpServers.setChangeListener(() => {
			void this.emit({ type: "mcp_servers_change", servers: this.runtime.mcpServers.list() });
		});

		for (const extension of this.extensions) {
			for (const [name, hint] of extension.removedToolHints ?? []) {
				actions.registerRemovedToolHint(name, hint);
			}
			for (const activator of extension.lazyToolActivators ?? []) {
				actions.registerLazyToolActivator(activator);
			}
		}

		// Flush provider registrations queued during extension loading, replaying the
		// original call order so last-registration-wins holds across mixed
		// legacy (name/config) and native registrations.
		for (const registration of drainPendingProviderRegistrations(this.runtime)) {
			try {
				if (registration.kind === "config") {
					if (providerActions?.registerProvider) {
						providerActions.registerProvider(registration.name, registration.config, registration.extensionPath);
					} else {
						this.modelRegistry.registerProvider(registration.name, registration.config);
					}
				} else if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(registration.provider, registration.extensionPath);
				} else {
					this.modelRegistry.registerProvider(registration.provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath: registration.extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		const registerVirtualModel = (definition: VirtualModelDefinition) => {
			if (providerActions?.registerVirtualModel) providerActions.registerVirtualModel(definition);
			else this.modelRegistry.registerVirtualModel(definition);
		};
		for (const { definition, extensionPath } of this.runtime.pendingVirtualModelRegistrations) {
			try {
				registerVirtualModel(definition);
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_virtual_model",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingVirtualModelRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config, extensionPath) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config, extensionPath);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider, extensionPath) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider, extensionPath);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
		this.runtime.registerVirtualModel = registerVirtualModel;
		this.runtime.unregisterVirtualModel = (provider, id) => {
			if (providerActions?.unregisterVirtualModel) providerActions.unregisterVirtualModel(provider, id);
			else this.modelRegistry.unregisterVirtualModel(provider, id);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.editAssistantMessageHandler = actions.editAssistantMessage;
			this.editUserMessageHandler = actions.editUserMessage;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.editAssistantMessageHandler = async () => ({ cancelled: false });
		this.editUserMessageHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = undefined;
	}

	private requestReload(): Promise<void> {
		if (!this.reloadHandler) return Promise.resolve();
		if (!this.reloadRequestPromise) {
			this.reloadRequestPromise = this.reloadHandler().finally(() => {
				this.reloadRequestPromise = undefined;
			});
		}
		return this.reloadRequestPromise;
	}

	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext;
		this.mode = mode;
	}

	setToolHookLifecycleObserver(observer?: ExtensionToolHookLifecycleObserver): void {
		this.toolHookLifecycleObserver = observer;
	}

	setLifecycleAttentionObserver(observer: () => void): void {
		this.lifecycleAttentionObserver = observer;
	}

	getLifecycleHumanWait(): Omit<import("../session-lifecycle-types.ts").HumanWait, "originSessionId"> | undefined {
		const prompt = this.activeUIPrompt;
		if (this.mode === "rpc" || !prompt) return undefined;
		return {
			kind: prompt.kind === "confirm" ? "approval" : "question",
			requestId: prompt.requestId,
			revision: 1,
			since: prompt.since,
		};
	}

	private wrapUIPromptContext(ui: ExtensionUIContext): ExtensionUIContext {
		const questionFn = ui.question;
		return inheritMcpMrtrPresentation(ui, {
			...ui,
			select: (title, options, opts) => this.withUIPrompt("select", title, () => ui.select(title, options, opts)),
			confirm: (title, message, opts) => this.withUIPrompt("confirm", title, () => ui.confirm(title, message, opts)),
			input: (title, placeholder, opts) =>
				this.withUIPrompt("input", title, () => ui.input(title, placeholder, opts)),
			editor: (title, prefill) => this.withUIPrompt("editor", title, () => ui.editor(title, prefill)),
			custom: (factory, options) => this.withUIPrompt("custom", undefined, () => ui.custom(factory, options)),
			...(questionFn
				? {
						question: (request, opts) =>
							this.withUIPrompt(
								"question",
								request.questions[0]?.header,
								() => questionFn(request, opts),
								request.requestId,
							),
					}
				: {}),
		});
	}

	private withUIPrompt<T>(
		kind: UIPromptKind,
		title: string | undefined,
		run: () => Promise<T>,
		requestId: string = crypto.randomUUID(),
	): Promise<T> {
		const outerPrompt = this.uiPromptDepth++ === 0;
		if (outerPrompt) {
			this.activeUIPrompt = { kind, title, requestId, since: new Date().toISOString() };
			this.lifecycleAttentionObserver?.();
			this.emitUIPromptEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind, ...(title ? { title } : {}) });
		}
		const finish = () => {
			if (--this.uiPromptDepth > 0) return;
			this.uiPromptDepth = 0;
			const prompt = this.activeUIPrompt ?? { kind, title };
			this.activeUIPrompt = undefined;
			this.lifecycleAttentionObserver?.();
			this.emitUIPromptEvent({
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: prompt.kind,
				...(prompt.title ? { title: prompt.title } : {}),
			});
		};
		try {
			return run().finally(finish);
		} catch (err) {
			finish();
			throw err;
		}
	}

	private emitUIPromptEvent(event: Extract<RunnerEmitEvent, { type: "ui_prompt_start" | "ui_prompt_end" }>): void {
		queueMicrotask(() => {
			void this.emit(event);
		});
	}

	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	/** True while session_start handlers run and the turns they trigger are still held. */
	sessionStartTurnsHeld(): boolean {
		return this.sessionStartTurns.holding;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	getExtensionIdentities(): Array<{ path: string; resolvedPath: string }> {
		return this.extensions.map(({ path, resolvedPath }) => ({ path, resolvedPath }));
	}

	readonly #reportedChildModuleReplacements = new Set<string>();

	/**
	 * Every registered child module by id. Unlike tools, the last extension to register an id wins, in load order; the
	 * replacement is logged once, so a module that shadows another (a builtin's included) is never silent.
	 */
	getAllChildModules(): Map<string, RegisteredChildModule> {
		const modules = new Map<string, RegisteredChildModule>();
		for (const ext of this.extensions)
			for (const [id, entry] of ext.childModules ?? []) {
				const earlier = modules.get(id);
				const replacement = `${id}\0${earlier?.sourceInfo.path}\0${entry.sourceInfo.path}`;
				if (
					earlier !== undefined &&
					earlier.sourceInfo.path !== entry.sourceInfo.path &&
					!this.#reportedChildModuleReplacements.has(replacement)
				) {
					this.#reportedChildModuleReplacements.add(replacement);
					console.warn(
						`Child module "${id}" from ${entry.sourceInfo.path} replaces the one from ${earlier.sourceInfo.path}`,
					);
				}
				modules.set(id, entry);
			}
		return modules;
	}

	/**
	 * Get all registered tools from all extensions. The first registration within a source tier
	 * wins, while a non-builtin extension may override a builtin extension tool.
	 */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				const existing = toolsByName.get(tool.definition.name);
				if (!existing || (existing.sourceInfo.source === "builtin" && tool.sourceInfo.source !== "builtin")) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Metadata-only denied roots declared by registered filesystem policies. */
	getFilesystemPolicyDeniedRoots(): readonly string[] {
		return this.extensions.flatMap((extension) =>
			(extension.filesystemPolicies ?? []).flatMap((policy) => policy.deniedRoots ?? []),
		);
	}

	onRpcEvent(handler: (event: ExtensionRpcEvent) => void): () => void {
		return this.eventBus.on(EXTENSION_RPC_EVENT_CHANNEL, (data) => {
			handler(data as ExtensionRpcEvent);
		});
	}

	/**
	 * Subscribe to a raw bus channel. Used by the session to observe activity
	 * signals extensions publish about work that outlives a turn (`wake_source_state`).
	 */
	onBusEvent(channel: string, handler: (data: unknown) => void): () => void {
		return this.eventBus.on(channel, handler);
	}

	/** Publish a session-originated signal on the shared bus, for extensions and hosts that observe it. */
	emitBusEvent(channel: string, data: unknown): void {
		this.eventBus.emit(channel, data);
	}

	/** Get extension-declared MCP servers (first declaration per name wins). */
	getRegisteredMcpServers(): readonly RegisteredMcpServerDeclaration[] {
		return this.runtime.mcpServers.declarations();
	}

	/** Whether a loaded extension handles `mcp_servers_change`, which makes it the one connecting registered servers. */
	extensionConnectsMcpServers(): boolean {
		return this.hasHandlers("mcp_servers_change");
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	get isActive(): boolean {
		return this.staleMessage === undefined;
	}

	/**
	 * Deferred `ctx.afterSessionStart` work runs only while this generation still owns its session: a switch,
	 * new session, reload or dispose during the `session_start` dispatch retires it, and its ctx would throw
	 * `StaleExtensionContextError` on first use. A returned promise is observed here so its rejection is
	 * reported, never unhandled; a stale error raised by a retirement mid-publish is dropped the same way.
	 */
	private runAfterSessionStart(publish: () => void | Promise<void>): void {
		if (this.staleMessage) return;
		const report = (error: unknown) => {
			if (error instanceof StaleExtensionContextError) return;
			this.emitError({
				extensionPath: RUNTIME_EXTENSION_PATH,
				event: "session_start",
				error: error instanceof Error ? error.message : String(error),
			});
		};
		try {
			void Promise.resolve(publish()).catch(report);
		} catch (error) {
			report(error);
		}
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new StaleExtensionContextError(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/**
	 * The host's budget for handlers of the queued lifecycle and boundary events, who hears their stalls, and the turn
	 * that owns a wait started now (the turn deadline releases only its own turn's waits).
	 */
	setEventHandlerBudget(
		budget: () => ExtensionHandlerBudget,
		onStall: (stall: ExtensionHandlerStall) => void,
		turnScope: () => number = () => 0,
	): void {
		this.eventHandlerBudget = budget;
		this.handlerStallListener = onStall;
		this.handlerTurnScope = turnScope;
	}

	/** Stops waiting on the given turn's handlers that are still running (the turn deadline's release). */
	releaseHeldHandlers(turn: number): number {
		return this.heldHandlerWaits.release(turn);
	}

	/**
	 * Resolved once per emission, before any handler starts. An invalid setting must never leave handlers unawaited,
	 * so it is reported once and the shipped defaults apply, as for `session_shutdown`.
	 */
	private resolveEventHandlerBudget(): ExtensionHandlerBudget {
		try {
			return this.eventHandlerBudget();
		} catch (err) {
			if (!this.reportedInvalidHandlerBudget) {
				this.reportedInvalidHandlerBudget = true;
				console.warn(
					`Using the default extension event handler budget (warn ${DEFAULT_EXTENSION_EVENT_HANDLER_WARN_MS}ms, hard cap ${DEFAULT_EXTENSION_EVENT_HANDLER_TIMEOUT_MS}ms): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			return {
				warnMs: DEFAULT_EXTENSION_EVENT_HANDLER_WARN_MS,
				timeoutMs: DEFAULT_EXTENSION_EVENT_HANDLER_TIMEOUT_MS,
			};
		}
	}

	private walkHandlers<R>(sequence: BudgetedSequence<R>): Promise<R> {
		return runBudgetedSequence(sequence, {
			budget: this.resolveEventHandlerBudget(),
			held: { waits: this.heldHandlerWaits, scope: this.handlerTurnScope },
			onStall: (stall) => this.handlerStallListener?.(stall),
		});
	}

	private reportStoppedHandler(
		extensionPath: string,
		event: string,
		verdict: HandlerStopVerdict,
		budget: ExtensionHandlerBudget,
	): void {
		const error =
			verdict === "timed_out"
				? `handler timed out after ${budget.timeoutMs}ms`
				: "handler released by the turn deadline";
		this.emitError({ extensionPath, event, error });
	}

	private reportHandlerFailure(extensionPath: string, event: string, err: unknown): void {
		this.emitError({
			extensionPath,
			event,
			error: err instanceof Error ? err.message : String(err),
			stack: err instanceof Error ? err.stack : undefined,
		});
	}

	/** Agent lifecycle events: every handler runs, serially, under the host budget (senpi#3650). */
	private dispatchLifecycle(event: RunnerEmitEvent): Promise<undefined> {
		const entries = flattenHandlers(this.extensions, event.type);
		return this.walkHandlers<undefined>({
			event: event.type,
			length: entries.length,
			extensionPath: (index) => entryAt(entries, index).path,
			start: (index) => {
				const { path, handler } = entryAt(entries, index);
				return handler(event, this.createContext(path));
			},
			settle: (index, outcome) => {
				if (!outcome.ok) this.reportHandlerFailure(entryAt(entries, index).path, event.type, outcome.error);
			},
			skip: (index, verdict, budget) =>
				this.reportStoppedHandler(entryAt(entries, index).path, event.type, verdict, budget),
			finish: () => undefined,
		});
	}

	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	private getToolHookStatusMessage(extensionPath: string, hookName: ExtensionToolHookName): string {
		const builtinMatch = /^<builtin:([^>]+)>$/.exec(extensionPath);
		const builtinName = builtinMatch?.[1];
		if (builtinName === "permission-system") {
			return "matching project rules";
		}
		if (builtinName === "bash-timeout") {
			return "applying bash timeout";
		}
		if (builtinName === "compaction") {
			return hookName === "PreToolUse" ? "checking compaction state" : "checking tool result size";
		}
		if (builtinName === "tool-pair-guard") {
			return "checking tool/result pairs";
		}

		const extensionName =
			builtinName ??
			(extensionPath.startsWith("<") && extensionPath.endsWith(">")
				? extensionPath.slice(1, -1)
				: basename(extensionPath).replace(/\.(?:c|m)?[jt]sx?$/, ""));
		return boundedToolHookStatusMessage(`running ${extensionName}`);
	}

	private emitToolHookLifecycleEvent(event: ExtensionToolHookLifecycleEvent): void {
		this.toolHookLifecycleObserver?.(event);
	}

	private beginToolHookRun(
		baseContext: ExtensionContext,
		run: {
			hookName: ExtensionToolHookName;
			toolName: string;
			toolCallId: string;
			extensionPath: string;
		},
	): {
		readonly context: ExtensionContext;
		end(status: ExtensionToolHookLifecycleStatus, errorMessage?: string): void;
	} {
		const base = {
			type: "tool_hook_status" as const,
			hookRunId: `${run.toolCallId}:${run.hookName}:${this.nextToolHookRunIndex++}`,
			hookName: run.hookName,
			toolName: run.toolName,
			toolCallId: run.toolCallId,
			extensionPath: run.extensionPath,
			startedAt: Date.now(),
		};
		let statusMessage = this.getToolHookStatusMessage(run.extensionPath, run.hookName);
		let ended = false;
		this.emitToolHookLifecycleEvent({ ...base, phase: "start", statusMessage });
		// Property descriptors keep the guarded getters from createContext() lazy; a
		// spread would freeze their current values and bypass stale-instance checks.
		const context = Object.defineProperties({}, Object.getOwnPropertyDescriptors(baseContext)) as ExtensionContext;
		context.updateToolHookStatus = (update: string) => {
			if (ended) return;
			statusMessage = sanitizedToolHookStatusMessage(update);
			this.emitToolHookLifecycleEvent({ ...base, phase: "update", statusMessage });
		};
		return {
			context,
			end: (status, errorMessage) => {
				if (ended) return;
				ended = true;
				this.emitToolHookLifecycleEvent({
					...base,
					phase: "end",
					statusMessage,
					completedAt: Date.now(),
					status,
					...(errorMessage !== undefined ? { errorMessage } : {}),
				});
			},
		};
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/** Every loaded extension's memory reporters, in load order; the report keeps the first of a name. */
	getMemoryReporters(): NamedMemoryReporter[] {
		return this.extensions.flatMap((ext) =>
			[...(ext.memoryReporters ?? new Map())].map(([name, reporter]) => ({ name, reporter })),
		);
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/** Options registered alongside the renderer `getEntryRenderer` returns for this custom type. */
	getEntryRendererOptions(customType: string): EntryRendererOptions | undefined {
		const owner = this.extensions.find((ext) => ext.entryRenderers?.has(customType));
		return owner?.entryRendererOptions?.get(customType);
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	async requestRpc(name: string, data: unknown, context?: ExtensionRpcRequestContext): Promise<unknown> {
		return requestExtensionRpc(this.extensions, name, data, context, () => this.assertActive());
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindExtensions().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(excludeBeforeProviderRequestExtensionPath?: string): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getServiceTier = this.getServiceTier;
		const getEffectiveServiceTier = this.getEffectiveServiceTier;
		const getScopedModels = this.getScopedModels;
		let compactionSignal: AbortSignal | undefined;
		const context: ExtensionContext = {
			offload: (id: string, args: unknown, options?: OffloadOptions) => {
				runner.assertActive();
				if (runner.offloadFn === undefined)
					return Promise.reject(new Error(`offload_unavailable: no session backs this context (offload ${id})`));
				return runner.offloadFn(id, args, options);
			},
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get agentDir() {
				runner.assertActive();
				return runner.getAgentDirFn();
			},
			get loadedExtensionPaths() {
				runner.assertActive();
				return runner.extensions.map((extension) => extension.resolvedPath);
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get goalStoreFile() {
				runner.assertActive();
				return goalFilePath(goalStoreRef(runner.sessionManager, runner.cwd));
			},
			get browserEngine() {
				runner.assertActive();
				return runner.getBrowserEngineFn();
			},
			get sessionEnv() {
				runner.assertActive();
				return runner.getSessionEnvFn();
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			get serviceTier() {
				runner.assertActive();
				return getServiceTier();
			},
			get effectiveServiceTier() {
				runner.assertActive();
				return getEffectiveServiceTier();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			engineTurnsHeld: () => {
				runner.assertActive();
				return runner.engineTurnsHeldFn();
			},
			noteHeldWake: (source) => {
				runner.assertActive();
				runner.noteHeldWakeFn(source);
			},
			getPauseState: () => {
				runner.assertActive();
				return runner.pauseActions.getPauseState?.() ?? { pauseSeq: 0, holds: [] };
			},
			fenceRun: (runRef) => {
				runner.assertActive();
				runner.pauseActions.fenceRun?.(runRef);
			},
			releaseRunFence: (runRef) => {
				runner.assertActive();
				runner.pauseActions.releaseRunFence?.(runRef);
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			get kernelTools() {
				runner.assertActive();
				const tools = kernelToolsStorage.getStore();
				if (!tools) return undefined;
				return {
					capabilities: tools.capabilities,
					describe: (names) => tools.describe(names),
					invoke: (request, options) => {
						runner.assertActive();
						return tools.invoke(request, {
							...(options && ("aborted" in options ? { signal: options } : options)),
							invoker: kernelToolInvokerStorage.getStore() ?? {
								sessionId: runner.sessionManager.getSessionId(),
							},
						});
					},
				} satisfies ExtensionKernelTools;
			},
			get evalHandleHost() {
				runner.assertActive();
				return runner.runtime.evalHandleHost;
			},
			abort: (source) => {
				runner.assertActive();
				runner.abortFn(source);
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			hasQueuedPersonInput: () => {
				runner.assertActive();
				return runner.hasQueuedPersonInputFn();
			},
			get requestReload() {
				runner.assertActive();
				return runner.reloadHandler ? () => runner.requestReload() : undefined;
			},
			get checkReloadVeto() {
				runner.assertActive();
				const probe = runner.checkReloadVetoFn;
				return probe ? () => probe() : undefined;
			},
			isCompacting: () => {
				runner.assertActive();
				return runner.isCompactingFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			getCompactionSettings: () => {
				runner.assertActive();
				return runner.getCompactionSettingsFn();
			},
			get getCompactionModel() {
				runner.assertActive();
				return runner.getCompactionModelFn
					? () => {
							runner.assertActive();
							return runner.getCompactionModelFn?.();
						}
					: undefined;
			},
			getPromptCacheSafeWaitSeconds: () => {
				runner.assertActive();
				return runner.getPromptCacheSafeWaitSecondsFn();
			},
			getPromptCacheGoalBackstopMaxSeconds: () => {
				runner.assertActive();
				return runner.getPromptCacheGoalBackstopMaxSecondsFn();
			},
			getPromptCacheKeepAliveSettings: () => {
				runner.assertActive();
				return runner.getPromptCacheKeepAliveSettingsFn();
			},
			onUserActivity: (listener) => {
				runner.assertActive();
				const unsubscribe = runner.onUserActivityFn?.((kind) => {
					try {
						listener(kind);
					} catch (error) {
						runner.emitError({
							extensionPath: excludeBeforeProviderRequestExtensionPath ?? RUNTIME_EXTENSION_PATH,
							event: "user_activity",
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
				return runner.runtime.trackEventBusSubscription(unsubscribe ?? (() => {}));
			},
			getLookAtSettings: () => {
				runner.assertActive();
				return runner.getLookAtSettingsFn();
			},
			getAskUserSettings: () => {
				runner.assertActive();
				return runner.getAskUserSettingsFn();
			},
			afterSessionStart: (publish) => {
				runner.assertActive();
				runner.sessionStartTurns.admit(() => runner.runAfterSessionStart(publish));
			},
			getImageSettings: () => {
				runner.assertActive();
				return runner.getImageSettingsFn();
			},
			get sessionSettings() {
				runner.assertActive();
				return runner.sessionSettingsFn;
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			prepareProviderRequest: async (messages, options) => {
				runner.assertActive();
				return runner.prepareProviderRequest(messages, excludeBeforeProviderRequestExtensionPath, options);
			},
			getPromptCachePrefixRequest: async (options) => {
				runner.assertActive();
				const build = runner.getPromptCachePrefixRequestFn;
				if (build === undefined) return { status: "skipped", reason: "the host builds no prompt-cache prefix" };
				return await build(options);
			},
			beginCompaction: (options) => {
				runner.assertActive();
				compactionSignal = runner.beginCompactionFn?.(options);
				return compactionSignal;
			},
			updateCompaction: (options) => {
				runner.assertActive();
				runner.updateCompactionFn?.({ ...options, signal: options.signal ?? compactionSignal });
			},
			endCompaction: (options) => {
				runner.assertActive();
				runner.endCompactionFn?.({ ...options, signal: options.signal ?? compactionSignal });
			},
			getMessageRevision: () => {
				runner.assertActive();
				return runner.getMessageRevisionFn();
			},
			applyCompaction: (precomputed, options) => {
				runner.assertActive();
				return runner.applyCompactionFn(precomputed, { ...options, signal: options.signal ?? compactionSignal });
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
			getSystemPromptOptions: () => {
				runner.assertActive();
				return runner.getSystemPromptOptionsFn();
			},
			getLoadedHookSources: () => {
				runner.assertActive();
				return runner.getLoadedHookSourcesFn();
			},
			getRegisteredMcpServers: () => {
				runner.assertActive();
				return runner.getRegisteredMcpServers();
			},
			extensionConnectsMcpServers: () => {
				runner.assertActive();
				return runner.extensionConnectsMcpServers();
			},
		};
		if (this.questionInput) {
			bindQuestionInput(context, () => {
				runner.assertActive();
				// The answer's own sendUserMessage follows synchronously and takes this token at admission.
				runner.personAnswerPending = true;
				queueMicrotask(() => {
					runner.personAnswerPending = false;
				});
				runner.questionInput?.();
			});
		}
		return context;
	}

	/**
	 * Create the context for executing the tool call `toolCallId`: the extension context plus
	 * `tools` and `executeTool()`. `signal` is the default signal of nested calls. `baseContext`
	 * is a per-invocation context the host already created (senpi: it carries `steeringSignal`);
	 * it must be a fresh object because the tool properties are defined on it.
	 */
	createToolContext(
		toolCallId: string,
		signal: AbortSignal | undefined,
		baseContext: ExtensionContext = this.createContext(),
	): ExtensionToolContext {
		const runner = this;
		// createContext() returns a fresh object, so adding properties does not affect other contexts.
		return Object.defineProperties(baseContext as ExtensionToolContext, {
			tools: {
				get() {
					runner.assertActive();
					return runner.getCallableToolsFn();
				},
			},
			executeTool: {
				value: async (name: string, args: unknown, options: ExecuteToolOptions = {}) => {
					runner.assertActive();
					if (!runner.executeToolFn) {
						return {
							toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
							result: {
								content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
								details: {},
							},
							isError: true,
						};
					}
					return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });
				},
			},
		});
	}

	createCommandContext(): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			if (typeof targetId === "string") return this.navigateTreeHandler(targetId, options);
			const { entryId, ...navigationOptions } = targetId;
			return this.navigateTreeHandler(entryId, navigationOptions);
		};
		context.editAssistantMessage = (entryId, text, options) => {
			this.assertActive();
			return this.editAssistantMessageHandler(entryId, text, options);
		};
		context.editUserMessage = (entryId, text, options) => {
			this.assertActive();
			return this.editUserMessageHandler(entryId, text, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.requestReload();
		};
		return context;
	}

	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
	): Promise<BoundaryDispatchResult> {
		const ctx = this.createContext();
		let entries: SessionBoundaryDraft[] = [];
		let shouldContinue = false;
		// Reported only when the runner retires before its first preview build completes.
		let context: BoundaryContextPreview = {
			contextEntries: [],
			contextMessages: [],
			llmMessages: [],
			pendingMessages: [],
			canContinue: false,
		};
		const retired = (): BoundaryDispatchResult => ({ entries: [], continue: false, context, valid: false });
		try {
			context = await buildContext(entries);
		} catch (err) {
			if (!this.isActive) return retired();
			throw err;
		}
		let valid = true;
		const handlers = flattenHandlers(this.extensions, baseEvent.type);

		// Boundary handlers hold the agent loop's turn end and the run's settle, so they run under the same host budget
		// as the lifecycle events and the turn deadline can release them (senpi#3650).
		return this.walkHandlers<BoundaryDispatchResult>({
			event: baseEvent.type,
			length: handlers.length,
			extensionPath: (index) => entryAt(handlers, index).path,
			halted: () => !this.isActive,
			start: (index) => {
				const event = {
					...baseEvent,
					entries,
					continue: shouldContinue,
					context,
				} as TurnEndEvent | AgentBeforeSettleEvent;
				return entryAt(handlers, index).handler(event, ctx);
			},
			settle: async (index, outcome) => {
				if (!this.isActive) return;
				const { path } = entryAt(handlers, index);
				if (outcome.ok) {
					const handlerResult = outcome.value as BoundaryResult | undefined;
					if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
					if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
				} else {
					this.reportHandlerFailure(path, baseEvent.type, outcome.error);
				}
				try {
					context = await buildContext(entries);
					valid = true;
				} catch (err) {
					if (!this.isActive) return;
					valid = false;
					this.emitError({
						extensionPath: path,
						event: baseEvent.type,
						error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			},
			skip: (index, verdict, budget) =>
				this.reportStoppedHandler(entryAt(handlers, index).path, baseEvent.type, verdict, budget),
			finish: () =>
				valid && this.isActive ? { entries, continue: shouldContinue, context, valid: true } : retired(),
		});
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_reload" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	/**
	 * Host budget for `session_shutdown` handlers, read from settings once per
	 * shutdown emission (teardown runs once per runner, so a settings edit takes
	 * effect without a reload). A malformed value must never break teardown, so
	 * an invalid setting is reported and the shipped defaults are used.
	 */
	/**
	 * The next `quit` emission ends in process exit, so its handlers share the total quit budget (senpi#3711). A quit
	 * that keeps the process alive (closing one session on an RPC host) keeps only the per-handler limits.
	 */
	armProcessExitBudget(): void {
		this.processExitRequestedAt ??= Date.now();
	}

	private resolveSessionShutdownBudget(): SessionShutdownBudget {
		try {
			const settings = SettingsManager.create(this.cwd, this.getAgentDirFn(), {
				projectTrusted: this.isProjectTrustedFn(),
			});
			return {
				handler: {
					warnMs: settings.getSessionShutdownHandlerWarnMs(),
					timeoutMs: settings.getSessionShutdownHandlerTimeoutMs(),
				},
				quitMs: settings.getSessionShutdownQuitBudgetMs(),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`Using the default session_shutdown handler budget (warn ${DEFAULT_SESSION_SHUTDOWN_HANDLER_WARN_MS}ms, hard cap ${DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS}ms, quit ${DEFAULT_SESSION_SHUTDOWN_QUIT_BUDGET_MS}ms): ${message}`,
			);
			return {
				handler: {
					warnMs: DEFAULT_SESSION_SHUTDOWN_HANDLER_WARN_MS,
					timeoutMs: DEFAULT_SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
				},
				quitMs: DEFAULT_SESSION_SHUTDOWN_QUIT_BUDGET_MS,
			};
		}
	}

	/**
	 * Runs one `session_shutdown` handler under the host budget. The handler sees
	 * the budget through `event.signal`, which this runner aborts at the hard cap;
	 * the host then stops waiting (the handler itself keeps running detached),
	 * reports an extension error and lets teardown continue with the next handler.
	 * Handler rejections are rethrown so emit()'s existing error path reports them
	 * exactly as before.
	 */
	private async runSessionShutdownHandler(
		extensionPath: string,
		event: SessionShutdownEvent,
		handler: (...args: unknown[]) => Promise<unknown>,
		{ budget, endsAtQuitDeadline }: QuitHandlerBudget,
	): Promise<void> {
		const startedAt = Date.now();
		const outcome = await runBudgetedHandler({
			extensionPath,
			event: "session_shutdown",
			budget,
			run: (signal) => handler({ ...event, signal }, this.createContext(extensionPath)),
			onStall: (stall) => {
				if (stall.stage !== "warn") return;
				const capNote = budget.timeoutMs > 0 ? ` (hard cap ${budget.timeoutMs}ms)` : "";
				console.warn(
					`Extension ${extensionPath} is still running its session_shutdown handler after ${stall.elapsedMs}ms${capNote}.`,
				);
			},
		});
		if (outcome.kind === "failed") throw outcome.error;
		if (outcome.kind === "timed_out" && endsAtQuitDeadline) {
			console.warn(
				`Extension ${extensionPath} session_shutdown handler overran the quit budget after ${Date.now() - startedAt}ms; quitting without it.`,
			);
		} else if (outcome.kind === "timed_out") {
			this.emitError({
				extensionPath,
				event: "session_shutdown",
				error: `handler timed out after ${budget.timeoutMs}ms`,
			});
		}
	}

	emitHeldWakesReleased(sources: Record<string, number>): Promise<void> {
		return this.emit({ type: "held_wakes_released", sources });
	}

	emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		// Not async: other events keep the exact microtask timing of a direct dispatch.
		// Turns requested from any session_start handler start after the last one returns (senpi#1972).
		if (event.type === "session_start") return this.sessionStartTurns.dispatch(() => this.dispatchEmit(event));
		if (QUEUED_LIFECYCLE_EVENTS.has(event.type)) {
			return this.dispatchLifecycle(event) as Promise<RunnerEmitResult<TEvent>>;
		}
		return this.dispatchEmit(event);
	}

	/**
	 * Move handlers carry state that exists nowhere else, so every failure (a throw, or a handler still running at the
	 * `session_shutdown` handler budget) is reported and returned: a `move` release refuses on an export failure, and
	 * the import hand-over keeps the moved state for the next open on an import failure.
	 */
	async emitSessionMove(event: SessionMoveEmission): Promise<readonly SessionMoveFailure[]> {
		const calls = flattenHandlers(this.extensions, event.type).map(({ path, handler }) => ({
			extensionPath: path,
			call: (signal: AbortSignal) => handler({ ...event, signal }, this.createContext(path)),
		}));
		const failures = await runSessionMoveHandlers(event.type, calls, this.resolveSessionShutdownBudget().handler);
		for (const failure of failures) this.emitError({ ...failure, event: event.type });
		return failures;
	}

	private async dispatchEmit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		let result: SessionBeforeEventResult | undefined;
		// Host-bounded events: a hung session_shutdown handler must not hold Ctrl+C / quit / reload / new / resume
		// hostage (agent lifecycle events take `dispatchLifecycle`, senpi#3650). Every other event still awaits its
		// handlers without a cap (ask-user and approval dialogs legitimately block).
		// The shutdown budget is resolved lazily so runners with no shutdown handler read no settings.
		const isSessionShutdown = event.type === "session_shutdown";
		let shutdownBudget: SessionShutdownBudget | undefined;
		let quitDeadline: QuitDeadline | undefined;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, event.type)) {
			for (const handler of handlers) {
				try {
					if (isSessionShutdown) {
						const shutdownEvent = event as SessionShutdownEvent;
						if (!shutdownBudget) {
							shutdownBudget = this.resolveSessionShutdownBudget();
							if (
								shutdownEvent.reason === "quit" &&
								this.processExitRequestedAt !== undefined &&
								shutdownBudget.quitMs > 0
							) {
								quitDeadline = new QuitDeadline(shutdownBudget.quitMs, Date.now, this.processExitRequestedAt);
							}
						}
						await this.runSessionShutdownHandler(
							ext.path,
							shutdownEvent,
							handler,
							quitDeadline?.budgetFor(shutdownBudget.handler) ?? {
								budget: shutdownBudget.handler,
								endsAtQuitDeadline: false,
							},
						);
						continue;
					}
					const handlerResult = await handler(event, this.createContext(ext.path));

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitModelSelect(event: ModelSelectEvent): Promise<ModelSelectEventResult | undefined> {
		let result: ModelSelectEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("model_select");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					// Re-read live prompt options per handler: an earlier handler that swaps
					// the active toolset (gpt-apply-patch) must let later handlers
					// (prompt-preset) rebuild from the post-swap tools in the same emission.
					const liveEvent: ModelSelectEvent = { ...event, systemPromptOptions: this.getSystemPromptOptionsFn() };
					const handlerResult = await handler(liveEvent, this.createContext(ext.path));
					if (handlerResult) {
						const nextResult = handlerResult as ModelSelectEventResult;
						if (nextResult.systemPrompt !== undefined || nextResult.systemPromptName !== undefined) {
							const combinedResult: ModelSelectEventResult = {};
							if (nextResult.systemPrompt !== undefined) {
								combinedResult.systemPrompt = nextResult.systemPrompt;
							} else if (result?.systemPrompt !== undefined) {
								combinedResult.systemPrompt = result.systemPrompt;
							}
							if (nextResult.systemPromptName !== undefined) {
								combinedResult.systemPromptName = nextResult.systemPromptName;
							} else if (result?.systemPromptName !== undefined) {
								combinedResult.systemPromptName = result.systemPromptName;
							}
							result = combinedResult;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "model_select",
						error: message,
						stack,
					});
				}
			}
		}

		return result;
	}

	emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		let currentMessage = event.message;
		let modified = false;
		const entries = flattenHandlers(this.extensions, "message_end");
		return this.walkHandlers<AgentMessage | undefined>({
			event: "message_end",
			length: entries.length,
			extensionPath: (index) => entryAt(entries, index).path,
			start: (index) => {
				const { path, handler } = entryAt(entries, index);
				const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
				return handler(currentEvent, this.createContext(path));
			},
			settle: (index, outcome) => {
				const { path } = entryAt(entries, index);
				if (!outcome.ok) {
					this.reportHandlerFailure(path, "message_end", outcome.error);
					return;
				}
				const handlerResult = outcome.value as MessageEndEventResult | undefined;
				if (!handlerResult?.message) return;
				if (handlerResult.message.role !== currentMessage.role) {
					this.emitError({
						extensionPath: path,
						event: "message_end",
						error: "message_end handlers must return a message with the same role",
					});
					return;
				}
				currentMessage = handlerResult.message;
				modified = true;
			},
			skip: (index, verdict, budget) =>
				this.reportStoppedHandler(entryAt(entries, index).path, "message_end", verdict, budget),
			finish: () => (modified ? currentMessage : undefined),
		});
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_result")) {
			for (const handler of handlers) {
				const hookRun = this.beginToolHookRun(this.createContext(), {
					hookName: "PostToolUse",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					extensionPath: ext.path,
				});
				let endStatus: ExtensionToolHookLifecycleStatus = "completed";
				let errorMessage: string | undefined;
				try {
					const handlerResult = (await handler(currentEvent, hookRun.context)) as
						| ToolResultEventResult
						| undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						// Structured content that is not replaced along with the content may no longer match it.
						if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.structuredContent !== undefined) {
						currentEvent.structuredContent = handlerResult.structuredContent;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					endStatus = "failed";
					errorMessage = message;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				} finally {
					hookRun.end(endStatus, errorMessage);
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			structuredContent: currentEvent.structuredContent,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		let result: ToolCallEventResult | undefined;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "tool_call")) {
			for (const handler of handlers) {
				const hookRun = this.beginToolHookRun(this.createContext(), {
					hookName: "PreToolUse",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					extensionPath: ext.path,
				});
				let endStatus: ExtensionToolHookLifecycleStatus = "completed";
				let errorMessage: string | undefined;
				try {
					const handlerResult = await handler(event, hookRun.context);

					if (handlerResult) {
						result = handlerResult as ToolCallEventResult;
						if (result.block) {
							endStatus = "blocked";
							return result;
						}
					}
				} catch (err) {
					endStatus = "failed";
					errorMessage = err instanceof Error ? err.message : String(err);
					throw err;
				} finally {
					hookRun.end(endStatus, errorMessage);
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "user_bash")) {
			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, this.createContext());
					if (handlerResult === undefined) continue;
					if (!isUserBashEventResult(handlerResult)) {
						throw new Error(
							"Invalid user_bash handler result: return undefined for local execution or exactly one valid { operations } or { result } object",
						);
					}
					return handlerResult;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
					throw err;
				}
			}
		}

		return undefined;
	}

	/**
	 * Run the request-time transforms in two phases. `context` handlers see the conversation
	 * only and the runner restores the prompt and tool state after each; `context_with_system`
	 * handlers then see the full transcript and their output is used as returned.
	 */
	async emitContext(
		messages: AgentMessage[],
		excludeExtensionPath?: string,
		source: ContextEvent["source"] = "agent",
	): Promise<AgentMessage[]> {
		return dispatchContextMessages(messages, {
			contextHandlers: snapshotEventHandlers(this.extensions, "context"),
			contextWithSystemHandlers: snapshotEventHandlers(this.extensions, "context_with_system"),
			createContext: (path) => this.createContext(path),
			emitError: (error) => this.emitError(error),
			excludeExtensionPath,
			source,
		});
	}

	async prepareProviderRequest(
		messages: AgentMessage[],
		excludeExtensionPath?: string,
		options?: { allowServerSearch?: boolean },
	): Promise<ProviderRequestPreparation> {
		const transformedMessages = await this.emitContext(messages, excludeExtensionPath, "projection");
		return {
			messages: transformedMessages,
			transformPayload: async (payload) =>
				await this.emitBeforeProviderRequest(
					options?.allowServerSearch ? payload : disableServerSearch(payload),
					excludeExtensionPath,
				),
			transformHeaders: async (headers) => await this.emitBeforeProviderHeaders(headers),
		};
	}

	async emitBeforeProviderRequest(
		payload: unknown,
		excludeExtensionPath?: string,
		request?: { model: Model<Api>; headers: ProviderHeaders },
	): Promise<unknown> {
		let currentPayload = payload;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_request")) {
			if (ext.path === excludeExtensionPath) continue;
			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
						...(request ? { model: request.model, headers: request.headers } : {}),
					};
					const handlerResult = await handler(event, this.createContext(ext.path));
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_provider_headers")) {
			for (const handler of handlers) {
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await handler(event, this.createContext(ext.path));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	/** Use the loader's provenance, including bundled modules and generated global-default shims. */
	getThirdPartySessionStartPaths(): string[] {
		return this.extensions
			.filter((ext) => ext.sourceInfo.source !== "builtin" && (ext.handlers.get("session_start")?.length ?? 0) > 0)
			.map((ext) => ext.path);
	}

	/** Paths of extensions with a `before_agent_start` handler not registered `{ previewSafe: true }`. */
	getPreviewUnsafeBeforeAgentStartPaths(): string[] {
		const paths: string[] = [];
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start") ?? [];
			if (handlers.some((handler) => ext.previewSafeHandlers?.has(handler) !== true)) paths.push(ext.path);
		}
		return paths;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
		options: {
			readonly preview?: boolean;
			readonly signal?: AbortSignal;
			readonly trigger?: BeforeAgentStartEvent["trigger"];
			/** Internal size accounting; observes only preview composition, never real turns. */
			readonly observePrompt?: (contribution: {
				readonly path: string;
				readonly before: string;
				readonly after: string;
				readonly parts?: readonly DynamicSystemPromptPart[];
			}) => void;
		} = {},
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		let currentSystemPrompt = systemPrompt;
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		dispatch: for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "before_agent_start")) {
			for (const handler of handlers) {
				if (options.signal?.aborted === true) break dispatch;
				// A preview reaches only handlers that declared themselves side-effect free (senpi#2115).
				if (options.preview === true && ext.previewSafeHandlers?.has(handler) !== true) continue;
				try {
					// Keep guarded context getters lazy while giving each handler its
					// own legacy omitted-signal ownership slot.
					const ctx = Object.defineProperties(
						{},
						Object.getOwnPropertyDescriptors(this.createContext(ext.path)),
					) as ExtensionContext;
					ctx.getSystemPrompt = () => {
						this.assertActive();
						return currentSystemPrompt;
					};
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						trigger: options.trigger ?? "prompt",
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
						...(options.preview === true ? { preview: true } : {}),
					};
					const promptBefore = currentSystemPrompt;
					const handlerResult = await handler(event, ctx);
					let parts: readonly DynamicSystemPromptPart[] | undefined;

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) {
							messages.push(result.message);
						}
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							systemPromptModified = true;
							parts = result.systemPromptParts;
						}
					}
					if (options.preview === true) {
						options.observePrompt?.({
							path: ext.path,
							before: promptBefore,
							after: currentSystemPrompt,
							...(parts === undefined ? {} : { parts }),
						});
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: DiscoveredResourceEntry[];
		promptPaths: DiscoveredResourceEntry[];
		themePaths: DiscoveredResourceEntry[];
		hookPaths: DiscoveredResourceEntry[];
	}> {
		const skillPaths: DiscoveredResourceEntry[] = [];
		const promptPaths: DiscoveredResourceEntry[] = [];
		const themePaths: DiscoveredResourceEntry[] = [];
		const hookPaths: DiscoveredResourceEntry[] = [];
		const toEntry = (entry: ResourceDiscoverEntry, extensionPath: string): DiscoveredResourceEntry =>
			typeof entry === "string"
				? { path: entry, extensionPath }
				: entry.scope === undefined
					? { path: entry.path, extensionPath }
					: { path: entry.path, extensionPath, scope: entry.scope };

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "resources_discover")) {
			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason, scopedEntries: true };
					const handlerResult = await handler(event, this.createContext(ext.path));
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((entry) => toEntry(entry, ext.path)));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((entry) => toEntry(entry, ext.path)));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((entry) => toEntry(entry, ext.path)));
					}
					if (result?.hookPaths?.length) {
						hookPaths.push(...result.hookPaths.map((entry) => toEntry(entry, ext.path)));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths, hookPaths };
	}

	/** Awaits every `provider_login_start` handler in order; a failing handler is reported and the login goes on. */
	async emitProviderLoginStart(event: ProviderLoginStartEvent): Promise<void> {
		for (const { path, handler } of flattenHandlers(this.extensions, event.type)) {
			try {
				await handler(event, this.createContext(path));
			} catch (err) {
				this.reportHandlerFailure(path, event.type, err);
			}
		}
	}

	/**
	 * Emit input event. Transforms chain, "handled" short-circuits. `attribution` defaults to what `source` alone
	 * implies (RPC input from a connection whose role is unknown is an agent's); the session passes the one it decides.
	 */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
		inputId = "input",
		attribution: InputAttribution = inputAttributionOf({ origin: inputOriginOf(source), source }),
	): Promise<InputEventResult> {
		let currentText = text;
		let currentImages = images;

		for (const { ext, handlers } of snapshotEventHandlers(this.extensions, "input")) {
			for (const handler of handlers) {
				try {
					const event: InputEvent = {
						type: "input",
						inputId,
						text: currentText,
						images: currentImages,
						source,
						attribution,
						streamingBehavior,
					};
					const result = (await handler(event, this.createContext(ext.path))) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
