import {
	isHostOwnedToolRuntimeCapability,
	type ToolRuntimeKind,
	toolRuntimeCapabilities,
} from "../../cli/tool-runtime.ts";
import { messagePathProjectRoot, resolveMessagePath } from "../../core/message-path-resolution.ts";
import { clientFacingIdentity } from "./client-admission-record.ts";
/**
 * Per-connection RPC handler.
 *
 * This is the transport-independent core extracted from `runRpcMode`. It owns
 * exactly one AgentSession runtime and speaks the JSONL RPC protocol over an
 * injected output sink and a caller-driven line feed. It knows nothing about
 * `process.stdout`, `process.stdin`, or process signals — those belong to the
 * host (classic single-connection stdio in `rpc-mode.ts` or another transport
 * adapter).
 *
 * Behaviour is byte-for-byte identical to the original `runRpcMode` command
 * loop: the same responses, the same event stream, the same extension-UI
 * bridge, the same backpressure discipline. The only difference is that writes
 * go to `sink.writeRaw` instead of `writeRawStdout`, and the caller decides how
 * (and whether) to end the process.
 */

import * as crypto from "node:crypto";
import { basename, dirname, extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { OAuthProviderId } from "@earendil-works/pi-ai/compat";
import { VERSION } from "../../config.ts";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { authMethodStatus, buildLoginProviderInfos } from "../../core/auth-providers.ts";
import { ContinueFromLeafError } from "../../core/continue-from-leaf.ts";
import { listCredentialAccounts, orderCredentialAccounts } from "../../core/credential-account-order.ts";
import { pinCredentialAccount, removeCredentialAccount } from "../../core/credential-accounts.ts";
import { AssistantEditError, SessionStreamingError } from "../../core/edited-assistant-message.ts";
import { UserEditError } from "../../core/edited-user-message.ts";
import {
	emitProviderAccountsChanged,
	subscribeProviderAccountEvents,
} from "../../core/extensions/builtin/anthropic-subscription/account-events.ts";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../../core/extensions/builtin/anthropic-subscription/account-management.ts";
import {
	isMcpControlInventoryChanged,
	MCP_CONTROL_INVENTORY_CHANGED_EVENT,
	MCP_CONTROL_INVENTORY_REQUEST_EVENT,
	type McpControlInventoryRequest,
} from "../../core/extensions/builtin/mcp/control-inventory.ts";
import type { McpWireStatusServer, McpWireStatusSnapshot } from "../../core/extensions/builtin/mcp/service-types.ts";
import {
	applyFastMode,
	type FastModeContext,
	resolveServiceTierMemoryModel,
} from "../../core/extensions/builtin/service-tier.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { ExtensionRpcRequestNotFoundError } from "../../core/extensions/runner.ts";
import { attachMcpGrantPresentation } from "../../core/mcp-grant-presentations.ts";
import { describeUsageLimitEntry, describeUsageLimitMessage } from "../../core/retry-fallback/usage-limit.ts";
import { carryRecovery } from "../../core/session-recovery-identity.ts";
import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";
import { storedKeyHint, verifyApiKey } from "../../core/verify-api-key.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { holdAutomaticInput } from "./automatic-input-gate.ts";
import { DURABLE_CLIENT_MESSAGE_ID_CAPABILITY } from "./client-admission-record.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { handleClientInput } from "./client-input-handler.ts";
import { ConnectionQuestionBridge, degradeQuestion, sessionQuestionBridges } from "./connection-question-bridge.ts";
import { CONNECTION_ROLE_FIXED, ConnectionRoles, roleConnection } from "./connection-roles.ts";
import {
	AUTH_KEY_VERIFY_CAPABILITY,
	AUTO_TITLE_SESSIONS_CAPABILITY,
	buildCustomUnsupportedRequest,
	CONTINUE_FROM_LEAF_CAPABILITY,
	DEFAULT_CUSTOM_EXTENSION_LABEL,
	EVAL_CELLS_CAPABILITY,
	EXTENSION_EVENTS_CAPABILITY,
	ENTRIES_TAIL_CAPABILITY,
	INTERACTIVE_USER_CAPABILITY,
	MEDIA_PLACEHOLDERS_CAPABILITY,
	QUESTION_CAPABILITY,
	QUEUED_MESSAGE_REVISION_CAPABILITY,
	RESUME_SESSION_CAPABILITY,
	RETRY_FALLBACK_COMMAND_CAPABILITY,
	SESSION_HELD_CAPABILITY,
	TOOL_BARRIER_CAPABILITY,
	TASK_PARENT_CAPABILITY,
} from "./custom-capability.ts";
import {
	type EffectCommandContext,
	runAbort,
	runGetEffectStatus,
	runQueuedInputChange,
	runSetModel,
	runSetThinkingLevel,
} from "./effect-commands.ts";
import { EffectLedger } from "./effect-ledger.ts";
import { EFFECT_LEDGER_CAPABILITY } from "./effect-record.ts";
import { createRpcEventOutputBuffer } from "./event-output-buffer.ts";
import { answeredUiRequestId, settleExtensionUiResponse } from "./extension-ui-response.ts";
import { answerGetEntries } from "./get-entries-command.ts";
import { runHoldInput } from "./held-input-commands.ts";
import { HostSessionControl } from "./host-session-control.ts";
import { createRpcLoginPromptCallbacks } from "./login-prompts.ts";
import { answerMemoryReport } from "./memory-report-command.ts";
import { protocolIdentity } from "./protocol-identity.ts";
import { buildRpcCommandsForSession, createCommandsChangedEvent, rpcCommandListDigest } from "./rpc-command-surface.ts";
import {
	rpcCommandPayloadError,
	rpcCommandShapeError,
	rpcMessageLengthError,
	sessionRetryFallbackError,
} from "./rpc-input-validation.ts";
import { buildRpcSessionState } from "./rpc-session-state.ts";
import { getSnapshot } from "./get-snapshot.ts";
import type { UiRequestChange } from "./snapshot-types.ts";
import { sessionUiAnswerLedger } from "./ui-answer-ledger.ts";
import type {
	RpcAuthProvider,
	RpcCommand,
	RpcExtensionEvent,
	RpcExtensionUIProgress,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcLoadedExtension,
	RpcLoadedMcpServer,
	RpcMcpServerStatus,
	RpcResponse,
	RpcSessionReplacedEvent,
} from "./rpc-types.ts";
import {
	RPC_ERROR_EVAL_CELL_NOT_FOUND,
	RPC_ERROR_EVAL_CELLS_UNAVAILABLE,
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_INVALID_EVAL_CELL_REQUEST,
	RPC_ERROR_MEDIA_NOT_FOUND,
	RPC_ERROR_MODEL_NOT_FOUND,
	STEER_WHEN_IDLE_CAPABILITY,
	USER_ACTIVITY_CAPABILITY,
} from "./rpc-types.ts";
import { runPauseForRun, runResumeForRun } from "./run-hold-commands.ts";
import { availableModelsData, interruptRunningTurn } from "./session-control-actions-data.ts";
import { SessionExtensionUiRequests, sessionDialogRequests } from "./session-extension-ui-requests.ts";
import { subscribeSessionRecords } from "./session-record-stream.ts";
import { subscribeStructuredSessionRecords } from "./structured-session-records.ts";
import { RpcSessionRelocation } from "./session-relocation.ts";
import {
	answerHostResponse,
	isHostResponse,
	type RelocationClientInfo,
	relocationChannel,
} from "./session-relocation-channel.ts";

export { buildRpcSessionState } from "./rpc-session-state.ts";

/** Additive per-connection options. Absent = classic default (byte-identical). */
export interface RpcConnectionOptions {
	/** Client capability flags from the handshake (e.g. custom_unsupported opt-in). */
	capabilities?: readonly string[];
	/** The host's per-connection role registry; a single-connection process keeps its own. */
	connectionRoles?: ConnectionRoles;
	/** Called instead of requesting process shutdown for a session-owned binding. */
	shutdownHandler?: () => void;
	/** Session registries own runtime disposal themselves. */
	disposeRuntime?: boolean;
	/** Shared workers flush synchronously into their bounded IPC credit channel. */
	eventFlushScheduler?: (flush: () => void) => void;
	/** Multi-session routing handle. Absent preserves classic wire output exactly. */
	sessionId?: string;
	/**
	 * A single-session `--mode rpc` process: it accepts `set_retry_fallback` and advertises it. A host's
	 * session connection leaves it off; a host session takes its chain from `open_session.retryFallback`.
	 */
	retryFallbackCommand?: boolean;
	/** A single-session `--mode rpc` process advertises its `--tool-runtime` as `tool_runtime:<value>`. */
	toolRuntime?: ToolRuntimeKind;
	/**
	 * Shared-session capability registry. A `set_client_info` carrying `capabilities`
	 * registers them for the connection that sent it; absent on a classic connection.
	 */
	clientInfo?: RelocationClientInfo & {
		setCapabilities: (connectionId: string | undefined, capabilities: readonly string[]) => void;
		hasCapability?: (connectionId: string, capability: string) => boolean;
	};
	bindSecurityPresentation?: (
		session: AgentSessionRuntime["session"],
		ui: ExtensionUIContext,
	) => (() => void) | undefined;
	bindMcpForms?: (
		session: AgentSessionRuntime["session"],
		ui: ExtensionUIContext,
	) => (() => void) | undefined | Promise<(() => void) | undefined>;
	/** A worker's internal bridge is gated by its host's actual socket capabilities. */
	workerSecurityBridge?: boolean;
	grantDialogSettled?: (id: string) => void;
	/** Shared hosts dedupe `loaded_surfaces_changed` per connection by inventory digest; absent emits inline. */
	publishLoadedSurfacesChanged?: (previous: string | undefined, digest: string) => void;
}

/**
 * The output side of a connection. `writeRaw` receives already-serialized JSONL
 * text (LF-terminated). `waitForBackpressure` lets the host apply flow control
 * (stdout drain in classic mode, or the transport's own `drain` signal).
 */
export interface RpcConnectionSink {
	writeRaw(chunk: string): void;
	/** Shared bindings accept correlated records synchronously, before JSONL buffering. */
	writeRecord?(record: object): void;
	/** The internal structured lane (senpi#4272): seeded records and block controls, never a legacy destination. */
	writeStructured?(record: object): void;
	waitForBackpressure(): Promise<void>;
	/** Tears the transport down once its event queue can no longer deliver (overflow, write failure). */
	close?(): void;
}

export interface RpcConnectionHandler {
	/**
	 * Resolves once the initial session bind completes. Awaiting it guarantees the
	 * extension UI context is installed (used by tests that drive ctx.ui directly).
	 */
	readonly ready: Promise<void>;
	/** Feed one inbound JSONL line (command or extension_ui_response). */
	handleInputLine(line: string): Promise<void>;
	/**
	 * `prompt` calls this handler started that have not settled. The command answers before the
	 * prompt's preflight ends, so this is the only record of a prompt that has not started its run yet.
	 */
	pendingPrompts(): readonly Promise<unknown>[];
	/**
	 * True once an extension requested shutdown via the shutdown handler. The
	 * host polls this after each command and decides how to tear down.
	 */
	isShutdownRequested(): boolean;
	/** Cancel UI requests that can no longer be answered by this connection. */
	cancelPendingExtensionUiRequests(): void;
	/** A shared host's connection left this session; what it was offering ends. */
	connectionDetached(connectionId: string): void;
	/**
	 * Tear down subscriptions and dispose the runtime. Never calls process.exit; `processExit` tells the runtime the
	 * caller exits right after (senpi#3711).
	 */
	dispose(options?: { readonly processExit?: boolean }): Promise<void>;
}

/** The tool call a dialog is about, as wire fields (absent when the dialog is not a permission request). */
function dialogCall(opts: ExtensionUIDialogOptions | undefined): { toolCallId?: string; parentToolCallId?: string } {
	if (opts?.toolCallId === undefined) return {};
	return {
		toolCallId: opts.toolCallId,
		...(opts.parentToolCallId === undefined ? {} : { parentToolCallId: opts.parentToolCallId }),
	};
}

function loadedExtensionName(path: string): string {
	const synthetic = /^<(?:builtin|inline):([^>]+)>$/.exec(path);
	if (synthetic) return synthetic[1];
	const withoutExtension = basename(path, extname(path));
	if (withoutExtension !== "index") return withoutExtension;
	const parent = dirname(path);
	const parentName = basename(parent);
	return parentName === "src" || parentName === "dist" ? basename(dirname(parent)) : parentName;
}

function loadedExtensions(session: AgentSession): RpcLoadedExtension[] {
	return session.resourceLoader.getExtensions().extensions.map((extension) => ({
		name: loadedExtensionName(extension.path),
		path: extension.path,
		sourceInfo: extension.sourceInfo,
		enabled: true,
	}));
}

function loadedMcpStatus(server: McpWireStatusServer): RpcMcpServerStatus {
	if (server.status !== undefined) return server.status;
	if (server.serverInfo !== null) return "connected";
	if (server.authStatus === "notLoggedIn") return "needs_auth";
	return "enabled";
}

function loadedMcpServers(snapshot: McpWireStatusSnapshot): RpcLoadedMcpServer[] {
	return snapshot.servers.map((server) => ({
		name: server.name,
		toolCount: server.tools.length,
		status: loadedMcpStatus(server),
		authStatus: server.authStatus,
		...(server.lastError === undefined ? {} : { lastError: server.lastError }),
	}));
}

function loadedSurfacesFingerprint(
	session: AgentSession,
	extensions: readonly RpcLoadedExtension[],
	mcpServers: readonly RpcLoadedMcpServer[],
): string {
	return JSON.stringify({
		skills: session.resourceLoader.getSkills().skills.map((skill) => ({
			name: skill.name,
			path: skill.filePath,
			sourceInfo: skill.sourceInfo,
			enabled: !skill.disableModelInvocation,
		})),
		extensions,
		mcpServers,
	});
}

/**
 * Locate one media block inside a tool result by `(toolCallId, contentIndex)`.
 *
 * Durable session entries are searched first: they survive the live message window
 * being compacted or trimmed away. The live `session.messages` cover the window
 * between `tool_execution_end` and persistence. Returns `undefined` unless the index
 * lands on an actual image block, so a text block or an out-of-range index is
 * reported as `media_not_found` rather than as a differently-shaped success.
 */
function findToolResultMedia(
	session: AgentSession,
	toolCallId: string,
	contentIndex: number,
): ImageContent | undefined {
	const fromContent = (content: unknown): ImageContent | undefined => {
		if (!Array.isArray(content)) return undefined;
		const block = content[contentIndex] as ImageContent | undefined;
		return block?.type === "image" ? block : undefined;
	};
	const matches = (message: unknown): message is { role: "toolResult"; toolCallId: string; content: unknown } => {
		const candidate = message as { role?: unknown; toolCallId?: unknown } | null;
		return candidate?.role === "toolResult" && candidate.toolCallId === toolCallId;
	};

	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		if (!matches(entry.message)) continue;
		const found = fromContent(entry.message.content);
		if (found) return found;
	}
	for (const message of session.messages) {
		if (!matches(message)) continue;
		const found = fromContent(message.content);
		if (found) return found;
	}
	return undefined;
}

/**
 * Create a per-connection RPC handler bound to one runtime host and one sink.
 *
 * This performs the initial `rebindSession()` and returns synchronously with a
 * handler whose `handleInputLine` is ready to use. Signal handling, stdin
 * wiring, and process exit are intentionally NOT done here.
 */
export function createRpcConnectionHandler(
	runtimeHost: AgentSessionRuntime,
	sink: RpcConnectionSink,
	options: RpcConnectionOptions = {},
): RpcConnectionHandler {
	let clientCapabilities = options.capabilities;
	let unsubscribeSecurityNotices: (() => void) | undefined;
	let detachGrantPresentation: (() => void) | undefined;
	let grantPresentationAbort = new AbortController();
	let securityBoundByHost = false;
	const connectionRoles = options.connectionRoles ?? new ConnectionRoles();
	const currentConnectionId = (): string => roleConnection(options.clientInfo?.connectionId());
	const hasRole = (role: string): boolean => connectionRoles.has(currentConnectionId(), role);
	const routingSessionId = options.sessionId;
	// True only while THIS connection's own command drives a replacement; the issuer
	// already learns the new identity from its command response.
	let replacementIssuedHere = false;
	let session = runtimeHost.session;
	let sessionControl: HostSessionControl | undefined;
	let relocation: RpcSessionRelocation | undefined;
	const promptCalls = new Set<Promise<unknown>>();
	// Set by the first command that asks this session for a turn; `set_retry_fallback` is refused after it.
	let turnRequested = false;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeStructured: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let unsubscribeLoadedSurfaces: (() => void) | undefined;
	let unsubscribeExtensionEvents: (() => void) | undefined;
	let mcpWireStatus: McpWireStatusSnapshot = { servers: [] };
	/** Abort owner of the last settled turn; `session.currentAbortSource` clears on settle. */
	let lastAbortSource: AgentAbortSource | undefined;
	let loadedSurfacesDigest: string | undefined;
	let rpcCommandsDigest: string | undefined;
	let suppressLoadedSurfaceEvents = false;
	const eventOutput = sink.writeRecord
		? undefined
		: createRpcEventOutputBuffer(sink.writeRaw, options.eventFlushScheduler);

	const effectContext = (): EffectCommandContext => ({
		session,
		by: { connectionId: options.clientInfo?.connectionId() ?? "local" },
		...(routingSessionId === undefined ? {} : { sessionId: routingSessionId }),
	});

	const tagSessionRecord = <T extends object>(value: T): T | (T & { sessionId: string }) =>
		routingSessionId === undefined ? value : carryRecovery(value, { ...value, sessionId: routingSessionId });

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		const record = tagSessionRecord(obj);
		if (sink.writeRecord) sink.writeRecord(record);
		else eventOutput?.writeImmediate(record);
	};

	const outputEvent = (event: object) => {
		const record = tagSessionRecord(event);
		if (sink.writeRecord) sink.writeRecord(record);
		else eventOutput?.enqueueEvent(record);
	};

	const currentLoadedSurfaces = (): {
		data: { extensions: RpcLoadedExtension[]; mcpServers: RpcLoadedMcpServer[] };
		digest: string;
	} => {
		const extensions = loadedExtensions(session);
		const mcpServers = loadedMcpServers(mcpWireStatus);
		return {
			data: { extensions, mcpServers },
			digest: loadedSurfacesFingerprint(session, extensions, mcpServers),
		};
	};

	const recordLoadedSurfaces = (emitChange: boolean): ReturnType<typeof currentLoadedSurfaces> => {
		const current = currentLoadedSurfaces();
		const previous = loadedSurfacesDigest;
		const changed = previous !== undefined && previous !== current.digest;
		loadedSurfacesDigest = current.digest;
		if (emitChange && changed && !suppressLoadedSurfaceEvents) emitLoadedSurfacesChanged(previous, current.digest);
		return current;
	};

	const emitLoadedSurfacesChanged = (previous: string | undefined, digest: string): void => {
		if (options.publishLoadedSurfacesChanged) options.publishLoadedSurfacesChanged(previous, digest);
		else outputEvent({ type: "loaded_surfaces_changed" });
	};

	const requestMcpWireStatus = async (): Promise<void> => {
		let response: Promise<McpWireStatusSnapshot> | undefined;
		const request: McpControlInventoryRequest = {
			sessionId: session.sessionId,
			respond(snapshot) {
				response ??= snapshot;
			},
		};
		session.resourceLoader.emitExtensionEvent?.(MCP_CONTROL_INVENTORY_REQUEST_EVENT, request);
		mcpWireStatus = response === undefined ? { servers: [] } : await response;
	};

	const subscribeLoadedSurfaceEvents = (): void => {
		unsubscribeLoadedSurfaces?.();
		unsubscribeLoadedSurfaces = session.resourceLoader.onExtensionEvent?.(
			MCP_CONTROL_INVENTORY_CHANGED_EVENT,
			(data) => {
				if (!isMcpControlInventoryChanged(data) || data.sessionId !== session.sessionId) return;
				mcpWireStatus = data.snapshot;
				if (!suppressLoadedSurfaceEvents) recordLoadedSurfaces(true);
			},
		);
	};

	const unsubscribeProviderAccountEvents = subscribeProviderAccountEvents((event) => {
		if (event.type === "accounts_changed") {
			outputEvent({ type: "auth_accounts_changed", provider: event.provider });
			return;
		}
		outputEvent({
			type: "account_failover",
			provider: event.provider,
			from: event.from,
			to: event.to,
			reason: event.reason,
		});
	});

	const waitForRpcBackpressure = async (): Promise<void> => {
		eventOutput?.flushEvents();
		await sink.waitForBackpressure();
	};

	const success = <T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: unknown): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (
		id: string | undefined,
		command: string,
		message: string,
		errorCode?: string,
		errorData?: unknown,
	): RpcResponse => {
		const details =
			errorData === undefined && (command === "edit_user_message" || command === "navigate_tree")
				? { leafId: session.sessionManager.getLeafId() }
				: errorData;
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			...(errorCode ? { errorCode } : {}),
			...(details === undefined ? {} : { errorData: details }),
		};
	};

	// Pending extension UI requests waiting for response
	const uiRequestChanged = (change?: UiRequestChange): void => {
		session.refreshLifecycle();
		if (change && routingSessionId !== undefined) output(change);
	};
	const pendingExtensionRequests = new SessionExtensionUiRequests(uiRequestChanged);
	const grantRequests = new Map<string, string | undefined>();
	sessionDialogRequests.set(session, pendingExtensionRequests);
	const questions = new ConnectionQuestionBridge(output, uiRequestChanged);

	let shutdownRequested = false;

	// In-flight OAuth logins, keyed by provider. login_start registers one; the
	// login promise clears it on completion; login_cancel aborts it. The flow is
	// fire-command-then-subscribe: login_start responds immediately and the URL +
	// terminal result arrive as auth_login_url / auth_login_end events.
	const activeLogins = new Map<string, AbortController>();

	/** Helper for dialog methods with signal/timeout support */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
				if (grantRequests.delete(id)) options.grantDialogSettled?.(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				frame: { type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest,
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			if (request.grantSelect === true) grantRequests.set(id, options.clientInfo?.connectionId());
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}
	const selectGrantDialog: ExtensionUIContext["select"] = (title, choices, opts) =>
		createDialogPromise(
			opts,
			undefined,
			{
				method: "select",
				title,
				options: choices,
				timeout: opts?.timeout,
				grantSelect: true,
			},
			(response) =>
				"cancelled" in response && response.cancelled
					? undefined
					: "value" in response
						? response.value
						: undefined,
		);

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		question: (request, opts) =>
			clientCapabilities?.includes(QUESTION_CAPABILITY)
				? questions.ask(request, opts)
				: degradeQuestion(createExtensionUIContext(), request, opts),
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout, ...dialogCall(opts) },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout, ...dialogCall(opts) },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		setSubagentCost(costUsd: number | undefined): void {
			// Fire and forget, like setStatus: a client that renders the footer cost adds it there.
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setSubagentCost",
				costUsd: costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : undefined,
			} as RpcExtensionUIRequest);
		},

		setWorkingMessage(_message?: string): void {
			// Working message not supported in RPC mode - requires TUI loader access
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility not supported in RPC mode - requires TUI loader access
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization not supported in RPC mode - requires TUI loader access
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only string-array widgets cross the wire; a component factory needs a TUI to render into.
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
					...(content !== undefined && options?.actions !== undefined && options.actions.length > 0
						? { widgetActions: options.actions.map(({ label, command }) => ({ label, command })) }
						: {}),
				} as RpcExtensionUIRequest);
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		},

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		},

		setTitle(title: string): void {
			// Fire and forget - host can implement terminal title control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// Custom UI cannot be rendered in RPC mode. By default this returns
			// undefined synchronously with NO wire message — byte-identical to the
			// original behavior. ONLY when the client advertised the
			// "custom_unsupported" capability do we emit an additive notice request
			// so an opt-in client can render a "requires the classic TUI" dialog before
			// returning undefined. The name is best-effort: ctx.ui.custom carries no
			// extension identity, so a generic label is used.
			const request = buildCustomUnsupportedRequest(clientCapabilities, DEFAULT_CUSTOM_EXTENSION_LABEL);
			if (request) {
				output(request);
			}
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					frame: { type: "extension_ui_request", id, method: "editor", title, prefill },
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		},

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		},

		getEditorComponent() {
			// Custom editor components not supported in RPC mode
			return undefined;
		},

		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// Theme switching not supported in RPC mode
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		},
	});

	const refreshLoadedSurfacesAfter = async (operation: () => Promise<void>, resetMcp: boolean): Promise<void> => {
		const previousDigest = loadedSurfacesDigest;
		const wasSuppressed = suppressLoadedSurfaceEvents;
		suppressLoadedSurfaceEvents = true;
		if (resetMcp) mcpWireStatus = { servers: [] };
		let commandsChanged: ReturnType<typeof createCommandsChangedEvent>;
		try {
			await operation();
			await requestMcpWireStatus();
			loadedSurfacesDigest = currentLoadedSurfaces().digest;
			const commands = buildRpcCommandsForSession(session);
			commandsChanged = createCommandsChangedEvent(rpcCommandsDigest, commands);
			rpcCommandsDigest = rpcCommandListDigest(commands);
		} finally {
			suppressLoadedSurfaceEvents = wasSuppressed;
		}
		if (!wasSuppressed && commandsChanged) {
			outputEvent(commandsChanged);
		}
		if (!wasSuppressed && previousDigest !== undefined && previousDigest !== loadedSurfacesDigest) {
			emitLoadedSurfacesChanged(previousDigest, loadedSurfacesDigest);
		}
	};

	runtimeHost.setRebindSession(async () => {
		// AgentSessionRuntime invokes this callback while completing a replacement.
		// Do not await extension binding here: extensions may wait for session work
		// that the replacement still owns. The command response must acknowledge the
		// committed replacement; derived surfaces refresh out of band afterwards.
		await rebindSession(true);
	});

	const rebindAfterLocalReplacement = async (): Promise<void> => {
		replacementIssuedHere = true;
		try {
			await rebindSession();
		} finally {
			replacementIssuedHere = false;
		}
	};

	const refreshGrantPresentation = (): void => {
		grantPresentationAbort.abort();
		detachGrantPresentation?.();
		detachGrantPresentation = undefined;
		grantPresentationAbort = new AbortController();
		if (securityBoundByHost) return;
		if (!clientCapabilities?.includes("grant_select")) return;
		const signal = grantPresentationAbort.signal;
		detachGrantPresentation = attachMcpGrantPresentation(session.sessionId, (title, choices, opts) =>
			selectGrantDialog(title, choices, {
				...opts,
				signal: opts?.signal === undefined ? signal : AbortSignal.any([opts.signal, signal]),
			}),
		);
	};
	const subscribeExtensionEvents = (): void => {
		unsubscribeExtensionEvents = clientCapabilities?.includes(EXTENSION_EVENTS_CAPABILITY)
			? session.extensionRunner.onRpcEvent(({ name, data }) => {
					outputEvent({ type: "extension_event", name, data } satisfies RpcExtensionEvent);
				})
			: undefined;
	};

	/** A classic connection's own declaration (senpi#4006); a shared host routes it through `clientInfo` instead. */
	const replaceClientCapabilities = (next: readonly string[]): void => {
		const hadEvents = clientCapabilities?.includes(EXTENSION_EVENTS_CAPABILITY) ?? false;
		const hadQuestion = clientCapabilities?.includes(QUESTION_CAPABILITY) ?? false;
		clientCapabilities = next;
		// A structured question the client can no longer answer settles once as cancelled.
		if (hadQuestion && !next.includes(QUESTION_CAPABILITY)) questions.cancelAll();
		if (hadEvents === next.includes(EXTENSION_EVENTS_CAPABILITY)) return;
		unsubscribeExtensionEvents?.();
		subscribeExtensionEvents();
	};

	const rebindSession = async (deferRefresh = false): Promise<void> => {
		unbindMcpForms?.();
		unbindMcpForms = undefined;
		unsubscribeSecurityNotices?.();
		unsubscribeLoadedSurfaces?.();
		unsubscribeExtensionEvents?.();
		const replacedSession = session !== runtimeHost.session;
		session = runtimeHost.session;
		const hostedSecurity = options.bindSecurityPresentation?.(session, {
			...createExtensionUIContext(),
			select: selectGrantDialog,
		});
		securityBoundByHost = hostedSecurity !== undefined;
		refreshGrantPresentation();
		unsubscribeSecurityNotices =
			hostedSecurity ??
			session.securityNotices?.subscribe((snapshot) => {
				for (const notice of snapshot.notices)
					output({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "notify",
						notifyType: "warning",
						message: notice.message,
					});
			});
		sessionQuestionBridges.set(session, questions);
		sessionDialogRequests.set(session, pendingExtensionRequests);
		// Installed before the bind below: extensions register their control endpoint on session_start.
		sessionControl?.dispose();
		sessionControl = new HostSessionControl(
			session,
			runtimeHost.launchProfile?.sessionContext?.host_socket,
			(line) => void process.stderr.write(`senpi rpc session ${routingSessionId ?? "classic"}: ${line}\n`),
		);
		session.setControlEndpointHost?.(sessionControl);
		// Only a host session can be released for a move, so only it offers relocation (docs/rpc.md).
		relocation?.dispose();
		relocation =
			routingSessionId === undefined
				? undefined
				: new RpcSessionRelocation({
						session,
						pendingPrompts: () => [...promptCalls],
						channel: relocationChannel({
							capabilities: () => clientCapabilities,
							clientInfo: options.clientInfo,
							output,
							outputEvent,
						}),
					});
		session.setRelocationHost?.(relocation);
		if (replacedSession) {
			lastAbortSource = undefined;
			if (routingSessionId !== undefined || !replacementIssuedHere) {
				// A replacement can be driven by ANY attached client, so every connection must be
				// told the live binding moved and given the new authoritative identity. Emitted
				// before the derived-surface refresh so a client cannot act on the old identity in
				// the window the refresh takes.
				outputEvent({
					type: "session_replaced",
					durableSessionId: session.sessionId,
					sessionFile: session.sessionFile,
					cwd: session.sessionManager.getCwd(),
					sessionName: session.sessionName,
				} satisfies RpcSessionReplacedEvent);
			}
		}
		subscribeExtensionEvents();
		subscribeLoadedSurfaceEvents();
		// Subscribe to the replaced session before its bind runs, not after. The bind
		// is deferred by design - awaiting it would deadlock a client whose
		// session_start handler blocks on an extension_ui_request it cannot answer
		// while still awaiting the replacement response - and it still mutates the
		// session it owns: pi-rules appends a durable scan entry from session_start.
		// Those entries must reach every attached connection, and nothing else can
		// carry them, because the session file is not written until an assistant
		// message exists, so a client that misses the notification can never
		// reconstruct the session it is bound to. Installing here also drops the
		// previous session's subscription immediately instead of after the bind.
		installSessionSubscriptions();
		const extensionUi = createExtensionUIContext();
		unbindMcpForms = await options.bindMcpForms?.(session, extensionUi);
		const refresh = refreshLoadedSurfacesAfter(
			() =>
				session.bindExtensions({
					uiContext: extensionUi,
					mode: "rpc",
					commandContextActions: {
						waitForIdle: () => session.agent.waitForIdle(),
						newSession: async (options) => runtimeHost.newSession(options),
						fork: async (entryId, forkOptions) => {
							const result = await runtimeHost.fork(entryId, forkOptions);
							return { cancelled: result.cancelled };
						},
						navigateTree: async (targetId, options) => {
							const result = await session.navigateTree(targetId, {
								summarize: options?.summarize,
								customInstructions: options?.customInstructions,
								replaceInstructions: options?.replaceInstructions,
								label: options?.label,
								expectedLeafId: options?.expectedLeafId,
							});
							return { cancelled: result.cancelled };
						},
						editAssistantMessage: async (entryId, text, options) => {
							const result = await session.editAssistantMessage(entryId, text, {
								summarize: options?.summarize,
								customInstructions: options?.customInstructions,
								expectedLeafId: options?.expectedLeafId,
							});
							return { cancelled: result.cancelled, unchanged: result.unchanged, entryId: result.entryId };
						},
						editUserMessage: async (entryId, text, options) => {
							const result = await session.editUserMessage(entryId, text, {
								summarize: options?.summarize,
								customInstructions: options?.customInstructions,
								expectedLeafId: options?.expectedLeafId,
							});
							return { cancelled: result.cancelled, unchanged: result.unchanged, entryId: result.entryId };
						},
						switchSession: async (sessionPath, options) => {
							return runtimeHost.switchSession(sessionPath, options);
						},
						reload: async () => {
							await refreshLoadedSurfacesAfter(async () => {
								await session.reload();
							}, false);
						},
					},
					shutdownHandler: () => {
						if (options.shutdownHandler) {
							options.shutdownHandler();
						} else {
							shutdownRequested = true;
						}
					},
					onError: (err) => {
						output({
							type: "extension_error",
							extensionPath: err.extensionPath,
							event: err.event,
							error: err.error,
						});
					},
				}),
			true,
		);
		function installSessionSubscriptions(): void {
			unsubscribe?.();
			unsubscribeBackpressure?.();
			unsubscribe = subscribeSessionRecords(session, outputEvent, (abortSource) => {
				lastAbortSource = abortSource;
			});
			unsubscribeStructured?.();
			unsubscribeStructured = sink.writeStructured
				? subscribeStructuredSessionRecords(session, (record) => sink.writeStructured?.(tagSessionRecord(record)))
				: undefined;
			unsubscribeBackpressure = session.agent.subscribe(async () => {
				await waitForRpcBackpressure();
			});
		}
		// Seals what a previous load left nonterminal before any command can read or replay it.
		EffectLedger.forSession(session);
		if (deferRefresh) {
			// The subscription is already installed on the replaced session above, so
			// the deferred refresh only needs its failure reported. Re-installing here
			// would replay the settings-source selection a second time.
			void refresh.then(
				() => session.releaseSettledSessionMemory(),
				(cause) => {
					outputEvent({ type: "rpc_error", error: String(cause) });
				},
			);
			return;
		}
		await refresh;
		await ClientAdmissions.forSession(session).ready;
		// The open-time readers above (receipt seals, extension starts) read the full history; an idle
		// session lets it go now instead of holding it until its first turn settles (senpi#3519).
		session.releaseSettledSessionMemory();
	};

	/**
	 * Drive an OAuth login for one provider as fire-command-then-subscribe.
	 *
	 * Reuses AuthStorage.login (the same callbacks the classic TUI uses). Only the
	 * URL-based happy path is surfaced over RPC: onAuth emits an auth_login_url
	 * event, onProgress (for example a `provider_login_start` handler's download
	 * line) emits auth_login_progress, and success/failure/cancel emit a single
	 * auth_login_end event. Callbacks
	 * that need interactive mid-flow input (onPrompt/onSelect) are answered over
	 * the extension UI dialog channel, so clients may either answer the dialog or
	 * finish through the browser/callback-server path. An unanswered dialog never
	 * blocks that completion path: it is released the moment the login settles.
	 * Secrets are never emitted: only the provider id, the auth URL, the prompt
	 * text/option labels, and a success flag (plus a non-secret error message)
	 * cross the wire; a client's answer is consumed in-process.
	 */
	const startLogin = async (provider: string): Promise<void> => {
		// A second login_start for the same provider aborts the prior attempt.
		activeLogins.get(provider)?.abort();
		const controller = new AbortController();
		const settled = new AbortController();
		const loginSignal = AbortSignal.any([controller.signal, settled.signal]);
		activeLogins.set(provider, controller);
		const authStorage = session.modelRegistry.authStorage;
		// A replacement left by an earlier login is not this login's; drop it so it is never reported here.
		authStorage.takeReplacement(provider);

		try {
			await authStorage.login(provider as OAuthProviderId, {
				onAuth: (info) => {
					outputEvent({ type: "auth_login_url", provider, url: info.url });
				},
				onDeviceCode: (info) => {
					outputEvent({ type: "auth_login_url", provider, url: info.verificationUri });
				},
				...createRpcLoginPromptCallbacks(createExtensionUIContext(), loginSignal),
				onProgress: (message) => {
					outputEvent({ type: "auth_login_progress", provider, text: message });
				},
				signal: controller.signal,
			});
			session.modelRegistry.refresh();
			if (provider === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID) emitProviderAccountsChanged(provider);
			// The client shows what this login replaced and where the previous credential is (senpi#3486).
			const replacement = authStorage.takeReplacement(provider);
			outputEvent({ type: "auth_login_end", provider, success: true, ...replacement });
		} catch (loginError: unknown) {
			const message = loginError instanceof Error ? loginError.message : String(loginError);
			outputEvent({ type: "auth_login_end", provider, success: false, error: message });
		} finally {
			// Release any dialog still pending so it can never outlive the login.
			settled.abort();
			if (activeLogins.get(provider) === controller) {
				activeLogins.delete(provider);
			}
		}
	};

	/**
	 * Host capabilities for `applyFastMode`, mirroring what the `/fast` command passes from its
	 * extension context. The notification is dropped: a command response carries the message
	 * (`data` on success, `error` on refusal), so a duplicate `extension_ui_request` would be noise.
	 */
	const fastModeContext = (): FastModeContext => ({
		cwd: session.cwd,
		agentDir: session.agentDir,
		model: session.model,
		modelRegistry: session.modelRegistry,
		serviceTier: session.serviceTier,
		isProjectTrusted: () => session.settingsManager.isProjectTrusted(),
		notify: () => {},
		setSessionModel: async (model) => {
			if (!session.modelRuntime.hasConfiguredAuth(model.provider)) return false;
			await session.setSessionModel(model, { source: "rpc", actor: "set_fast_mode" });
			return true;
		},
		setSessionFastMode: (enabled) => session.setSessionFastMode(enabled),
	});

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			case "get_protocol_info":
				return {
					id,
					type: "response",
					command: "get_protocol_info",
					success: true,
					data: {
						protocolVersion: 1,
						serverVersion: VERSION,
						capabilities: [
							...new Set([
								"multi_session",
								"snapshot_cursor",
								"ui_answer_ledger",
								"session_lifecycle",
								AUTO_TITLE_SESSIONS_CAPABILITY,
								MEDIA_PLACEHOLDERS_CAPABILITY,
								DURABLE_CLIENT_MESSAGE_ID_CAPABILITY,
								EFFECT_LEDGER_CAPABILITY,
								STEER_WHEN_IDLE_CAPABILITY,
								CONTINUE_FROM_LEAF_CAPABILITY,
								EVAL_CELLS_CAPABILITY,
								AUTH_KEY_VERIFY_CAPABILITY,
								QUEUED_MESSAGE_REVISION_CAPABILITY,
								TOOL_BARRIER_CAPABILITY,
								USER_ACTIVITY_CAPABILITY,
								RESUME_SESSION_CAPABILITY,
								ENTRIES_TAIL_CAPABILITY,
								...(options.retryFallbackCommand ? [RETRY_FALLBACK_COMMAND_CAPABILITY] : []),
								...(options.toolRuntime ? toolRuntimeCapabilities(options.toolRuntime) : []),
								// Client flags cannot advertise a host guard this classic binding does not run, nor a tool runtime.
								...(options.capabilities ?? []).filter(
									(capability) =>
										capability !== SESSION_HELD_CAPABILITY && !isHostOwnedToolRuntimeCapability(capability),
								),
							]),
						],
						mode: "classic",
						...protocolIdentity(),
					},
				};
			case "open_session":
				return error(id, "open_session", "multi_session_disabled");

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				if (holdAutomaticInput(session, command, hasRole(INTERACTIVE_USER_CAPABILITY)))
					return success(id, "prompt", { disposition: "handled", heldAsNotice: true });
				turnRequested = true;
				const admission = handleClientInput(session, command, { output, promptCalls });
				promptCalls.add(admission);
				void admission.finally(() => promptCalls.delete(admission));
				return undefined;
			}

			case "append_user_message": {
				const content = command.content as Parameters<AgentSession["sendUserMessage"]>[0];
				const message =
					typeof content === "string"
						? { role: "user" as const, content, timestamp: Date.now() }
						: { role: "user" as const, content, timestamp: Date.now() };
				session.sessionManager.appendMessage(message);
				session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
				return success(id, "append_user_message");
			}

			case "append_session_entry": {
				session.appendSessionEntry(command.entry);
				return success(id, "append_session_entry");
			}

			case "continue_from_leaf": {
				turnRequested = true;
				try {
					await session.continueFromLeaf();
					return success(id, "continue_from_leaf");
				} catch (err) {
					if (err instanceof ContinueFromLeafError) return error(id, command.type, err.message, err.code);
					throw err;
				}
			}

			case "resume_session": {
				turnRequested = true;
				const { answer, settled } = await session.beginResume({
					expectedSeq: command.expectedSeq,
					mode: command.mode,
					message: command.message,
					effectId: command.effectId,
				});
				promptCalls.add(settled);
				void settled.then(
					() => promptCalls.delete(settled),
					(err: unknown) => {
						promptCalls.delete(settled);
						output({
							type: "extension_error",
							extensionPath: "runtime",
							event: "resume_session",
							error: err instanceof Error ? err.message : String(err),
						});
					},
				);
				return success(id, "resume_session", answer);
			}

			case "send_custom_message": {
				// A context message that asks for no turn does not block a launch-time chain, like an extension's.
				if (command.triggerTurn === true) turnRequested = true;
				await session.sendCustomMessage(
					{
						customType: command.customType,
						content: command.content as Parameters<AgentSession["sendCustomMessage"]>[0]["content"],
						display: command.display,
						details: command.details,
					},
					{ triggerTurn: command.triggerTurn, deliverAs: command.deliverAs },
				);
				return success(id, "send_custom_message");
			}

			case "steer":
			case "follow_up": {
				if (holdAutomaticInput(session, command, hasRole(INTERACTIVE_USER_CAPABILITY)))
					return success(id, command.type, { disposition: "handled", heldAsNotice: true });
				turnRequested = true;
				await handleClientInput(session, command, { output, promptCalls });
				return undefined;
			}

			case "abort":
				if (command.intent === "stop" && !hasRole(INTERACTIVE_USER_CAPABILITY))
					return error(
						id,
						"abort",
						"stop_requires_interactive_client: declare interactive_user with set_client_info first",
					);
				return runAbort(effectContext(), command, () =>
					(command.intent === "stop" ? session.stop() : session.abort()).catch((cause: unknown) => {
						// Report quiesce failures out of band; the answer never waits on them.
						outputEvent({ type: "rpc_error", error: String(cause) });
					}),
				);

			case "interrupt":
				if (command.intent === "stop" && !hasRole(INTERACTIVE_USER_CAPABILITY))
					return error(
						id,
						"interrupt",
						"stop_requires_interactive_client: declare interactive_user with set_client_info first",
					);
				if (command.intent === "stop") {
					// A Stop names the user's intent, not one turn: an automatic turn that started after the named one stops too.
					const stopped = await interruptRunningTurn(session, undefined, () => {
						ClientAdmissions.forSession(session).noteAbort(effectContext().by);
						return session.stop();
					});
					if (!stopped.interrupted) await session.stop();
					return success(id, "interrupt", stopped);
				}
				return success(
					id,
					"interrupt",
					await interruptRunningTurn(session, command.turnId, () => {
						ClientAdmissions.forSession(session).noteAbort(effectContext().by);
						return session.abort();
					}),
				);

			case "hold_input": {
				const answer = runHoldInput(session, command, {
					interactiveUser: hasRole(INTERACTIVE_USER_CAPABILITY),
					taskParent: hasRole(TASK_PARENT_CAPABILITY),
				});
				return answer.ok ? success(id, "hold_input", answer.data) : error(id, "hold_input", answer.error);
			}

			case "pause_for_run": {
				const answer = await runPauseForRun(session, command, hasRole(TASK_PARENT_CAPABILITY));
				return answer.ok ? success(id, "pause_for_run", answer.data) : error(id, "pause_for_run", answer.error);
			}

			case "resume_for_run": {
				const answer = await runResumeForRun(session, command, hasRole(TASK_PARENT_CAPABILITY));
				return answer.ok ? success(id, "resume_for_run", answer.data) : error(id, "resume_for_run", answer.error);
			}

			case "withdraw_held_input":
				if (!hasRole(INTERACTIVE_USER_CAPABILITY))
					return error(id, "withdraw_held_input", "hold_input_requires_interactive_client");
				return success(id, "withdraw_held_input", { withdrawn: session.withdrawHeldInput(command.inputId) });

			case "abort_compaction": {
				session.abortCompaction();
				return success(id, "abort_compaction");
			}

			case "reload": {
				const result = await session.reload();
				return success(id, "reload", result);
			}

			case "check_reload_veto": {
				return success(id, "check_reload_veto", await session.checkReloadVeto());
			}

			case "dequeue_message":
			case "edit_queued_message":
				return runQueuedInputChange(effectContext(), command);

			case "clear_queue": {
				ClientAdmissions.clearQueuedFor(session);
				const cleared = session.clearQueue({ abortWillFollow: command.abortWillFollow ?? false });
				await session.whenQueueClearRecorded();
				return success(id, "clear_queue", {
					steering: cleared.steering,
					followUp: cleared.followUp,
					ordered: [...cleared.ordered],
				});
			}

			case "get_steering_messages":
				return success(id, "get_steering_messages", {
					messages: [...session.getSteeringMessages()],
					ordered: session
						.getQueuedInputs()
						.filter((input) => input.mode === "steer")
						.map(clientFacingIdentity),
				});

			case "get_follow_up_messages":
				return success(id, "get_follow_up_messages", {
					messages: [...session.getFollowUpMessages()],
					ordered: session
						.getQueuedInputs()
						.filter((input) => input.mode === "followUp")
						.map(clientFacingIdentity),
				});

			case "abort_branch_summary":
				session.abortBranchSummary();
				return success(id, "abort_branch_summary");

			case "wake": {
				const deliveryIds = Array.isArray(command.delivery_ids)
					? command.delivery_ids.filter((entry): entry is string => typeof entry === "string")
					: undefined;
				const result = (await sessionControl?.wake(deliveryIds)) ?? {};
				return success(id, "wake", { admitted: result.admitted ?? [] });
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (routingSessionId === undefined && !result.cancelled && session !== runtimeHost.session)
					await rebindAfterLocalReplacement();
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "set_client_info": {
				const wasGrantCapable = clientCapabilities?.includes("grant_select") === true;
				if (command.capabilities !== undefined) {
					if (!connectionRoles.declare(currentConnectionId(), command.capabilities))
						return error(id, "set_client_info", CONNECTION_ROLE_FIXED);
					if (!options.clientInfo) replaceClientCapabilities(command.capabilities);
					else {
						clientCapabilities = command.capabilities;
						options.clientInfo.setCapabilities(options.clientInfo.connectionId(), command.capabilities);
					}
				}
				if (wasGrantCapable !== (clientCapabilities?.includes("grant_select") === true)) refreshGrantPresentation();
				return success(id, "set_client_info");
			}

			case "get_snapshot": {
				const snapshot = getSnapshot(session, command, {
					lastAbortSource,
					enqueue: (markerId) => {
						if (routingSessionId !== undefined) output({ type: "snapshot_marker", markerId });
					},
				});
				return "error" in snapshot
					? error(id, "get_snapshot", snapshot.error, RPC_ERROR_INVALID_ARGUMENT)
					: success(id, "get_snapshot", snapshot.data);
			}

			case "get_state":
				return success(id, "get_state", buildRpcSessionState(session, lastAbortSource));
			case "request_self_settle":
				return success(id, "request_self_settle", session.requestSelfSettle());

			case "get_effect_status":
				return runGetEffectStatus(effectContext(), command);

			case "get_pending_inputs":
				return success(id, "get_pending_inputs", await session.getPendingInputs(command.knownClientMessageIds));

			// =================================================================
			// Model
			// =================================================================

			case "set_model":
				return runSetModel(effectContext(), command);

			case "set_favorite_models":
				session.setFavoriteModels(command.models);
				return success(id, "set_favorite_models");

			case "set_scoped_models":
				session.setScopedModels(command.models);
				return success(id, "set_scoped_models");

			case "cycle_model": {
				const result = await session.cycleModel(command.direction, {
					origin: { source: "rpc", actor: "cycle_model" },
				});
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models":
				return success(id, "get_available_models", await availableModelsData(session));

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level":
				return runSetThinkingLevel(effectContext(), command);

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels":
				return success(id, "get_available_thinking_levels", {
					levels: session.getAvailableThinkingLevels(),
				});

			case "get_model_thinking_level": {
				if (typeof command.provider !== "string" || typeof command.modelId !== "string") {
					return error(
						id,
						"get_model_thinking_level",
						"get_model_thinking_level requires 'provider' and 'modelId'.",
						RPC_ERROR_INVALID_ARGUMENT,
					);
				}
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(
						id,
						"get_model_thinking_level",
						`Model not found: ${command.provider}/${command.modelId}`,
						RPC_ERROR_MODEL_NOT_FOUND,
					);
				}
				return success(id, "get_model_thinking_level", session.getThinkingLevelForModel(model));
			}

			// =================================================================
			// Fast mode
			// =================================================================

			case "set_fast_mode": {
				if (typeof command.enabled !== "boolean") {
					return error(id, "set_fast_mode", "set_fast_mode requires a boolean 'enabled' field.");
				}
				const model = session.model;
				if (!model) {
					return error(id, "set_fast_mode", "No active model.");
				}
				// Same entry point as the /fast command: persistence, `-fast` key normalization,
				// and pin precedence live in applyFastMode, never duplicated here.
				const result = await applyFastMode(fastModeContext(), command.enabled);
				if (!result.applied) {
					// A refusal (non-Codex model, active `:priority` pin, failed model switch) has no
					// notification channel for a command response, so it is reported as an error
					// instead of a success that silently did nothing.
					return error(id, "set_fast_mode", result.message);
				}
				const memoryModel = resolveServiceTierMemoryModel(session.modelRegistry, session.model ?? model);
				return success(id, "set_fast_mode", {
					enabled: result.enabled,
					serviceTier: result.recordedTier,
					provider: memoryModel.provider,
					modelId: memoryModel.id,
				});
			}

			case "get_fast_mode":
				return success(id, "get_fast_mode", {
					enabled: session.isFastModeActive(),
					serviceTier: session.effectiveServiceTier ?? null,
				});

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			case "set_retry_fallback": {
				if (!options.retryFallbackCommand) {
					return error(
						id,
						"set_retry_fallback",
						"set_retry_fallback is for a single-session rpc process; a host session takes open_session.retryFallback.",
					);
				}
				const profileError = sessionRetryFallbackError(command.retryFallback);
				if (profileError !== undefined || command.retryFallback === undefined) {
					return error(id, "set_retry_fallback", profileError ?? "set_retry_fallback needs retryFallback.");
				}
				// A launch-time setting: refused once this connection asked for a turn (even one not started yet), while
				// any turn runs, or once the session holds turn history, so a chain never changes under a turn or a
				// retry already in flight. Extension context messages (`custom`, e.g. one a component adds on
				// session_start) are not a turn and do not count.
				if (turnRequested || session.isStreaming || session.messages.some((message) => message.role !== "custom")) {
					return error(
						id,
						"set_retry_fallback",
						"set_retry_fallback must arrive before the session's first turn.",
					);
				}
				runtimeHost.setRetryFallback(command.retryFallback);
				return success(id, "set_retry_fallback");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "navigate_tree": {
				// Addressing refusals. The command type forbids both spellings at once and neither of
				// them, so TypeScript narrows these branches to `never` - they exist for the inbound
				// JSON no type can police, which is why the command name is written out here.
				if (command.entryId !== undefined && command.targetId !== undefined) {
					return error(id, "navigate_tree", "navigate_tree takes either entryId or targetId, not both");
				}
				if (command.entryId === undefined && command.targetId === undefined) {
					return error(id, "navigate_tree", "navigate_tree requires entryId or targetId");
				}
				const targetId = command.entryId ?? command.targetId;
				if (typeof targetId !== "string" || targetId.length === 0) {
					return error(id, command.type, "navigate_tree requires a non-empty entryId or targetId");
				}
				if (command.intent !== undefined && command.intent !== "select" && command.intent !== "resume") {
					return error(id, command.type, "navigate_tree intent must be select or resume");
				}
				try {
					// Core owns selection/resumption, summaries, cancellation, and root reset.
					// Pass the requested entry itself, not a client- or handler-computed parent.
					const result = await session.navigateTree(targetId, {
						...(command.intent !== undefined ? { intent: command.intent } : {}),
						summarize: command.summarize,
						customInstructions: command.customInstructions,
						replaceInstructions: command.replaceInstructions,
						label: command.label,
						expectedLeafId: command.expectedLeafId,
					});
					const leafId = session.sessionManager.getLeafId();
					if (command.targetId !== undefined) {
						return success(id, command.type, { ...result, leafId });
					}
					if (result.cancelled) {
						return success(id, command.type, {
							outcome: "cancelled",
							leafId,
							...(result.aborted ? { aborted: true } : {}),
						});
					}
					return success(id, command.type, {
						outcome: "navigated",
						leafId,
						...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
						...(result.summaryEntry ? { summaryEntryId: result.summaryEntry.id } : {}),
					});
				} catch (err) {
					if (err instanceof AssistantEditError || err instanceof SessionStreamingError) {
						return error(id, command.type, err.message, err.code);
					}
					throw err;
				}
			}

			case "record_bash_result":
				session.recordBashResult(command.command, command.result, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "record_bash_result");

			case "release_tool_barrier":
				return success(id, "release_tool_barrier", { released: session.releaseToolBarrier(command.barrierId) });

			case "set_label":
				session.sessionManager.appendLabelChange(command.entryId, command.label);
				return success(id, "set_label");

			case "bash": {
				if (routingSessionId !== undefined) outputEvent({ type: "bash_start" });
				try {
					const eventResult = await session.extensionRunner.emitUserBash({
						type: "user_bash",
						command: command.command,
						excludeFromContext: command.excludeFromContext ?? false,
						cwd: session.sessionManager.getCwd(),
					});
					if (eventResult?.result) {
						session.recordBashResult(command.command, eventResult.result, {
							excludeFromContext: command.excludeFromContext,
						});
						return success(id, "bash", eventResult.result);
					}
					const result = await session.executeBash(command.command, undefined, {
						excludeFromContext: command.excludeFromContext,
						id: command.executionId,
						// Functions cannot cross JSONL. Host extensions may still provide the
						// executable operations object; client-supplied data is only a wire-safe hint.
						operations: eventResult?.operations,
					});
					return success(id, "bash", result);
				} finally {
					if (routingSessionId !== undefined) outputEvent({ type: "bash_end" });
				}
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			case "cleanup_bash_output":
				await session.cleanupBashOutput(command.path);
				return success(id, "cleanup_bash_output");

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "resolve_path":
				return success(
					id,
					"resolve_path",
					resolveMessagePath({
						path: command.path,
						cwd: session.cwd,
						projectRoot: messagePathProjectRoot(session.cwd),
					}),
				);

			case "memory_report": {
				const answer = await answerMemoryReport(session);
				return answer.ok ? success(id, "memory_report", answer.data) : error(id, "memory_report", answer.error);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath, { themeName: command.themeName });
				return success(id, "export_html", { path });
			}

			case "export_jsonl": {
				return success(id, "export_jsonl", { path: session.exportToJsonl(command.outputPath) });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath, { cwdOverride: command.cwdOverride });
				if (routingSessionId === undefined && !result.cancelled && session !== runtimeHost.session)
					await rebindAfterLocalReplacement();
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId, { position: command.position });
				if (routingSessionId === undefined && !result.cancelled && session !== runtimeHost.session)
					await rebindAfterLocalReplacement();
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "edit_assistant_message": {
				if (
					typeof command.entryId !== "string" ||
					command.entryId.length === 0 ||
					typeof command.text !== "string"
				) {
					return error(id, command.type, "edit_assistant_message requires a non-empty entryId and a text string");
				}
				try {
					const result = await session.editAssistantMessage(command.entryId, command.text, {
						summarize: command.summarize,
						customInstructions: command.customInstructions,
						expectedLeafId: command.expectedLeafId,
					});
					const leafId = session.sessionManager.getLeafId();
					if (result.unchanged) {
						return success(id, command.type, { outcome: "unchanged", leafId });
					}
					if (result.cancelled) {
						return success(id, command.type, {
							outcome: "cancelled",
							leafId,
							...(result.aborted ? { aborted: true } : {}),
						});
					}
					const entry = result.entryId ? session.sessionManager.getEntry(result.entryId) : undefined;
					if (entry?.type !== "message" || leafId === null) {
						return error(id, command.type, "Edited assistant entry was not persisted");
					}
					return success(id, command.type, {
						outcome: "edited",
						entry,
						leafId,
						...(result.summaryEntry ? { summaryEntryId: result.summaryEntry.id } : {}),
					});
				} catch (err) {
					if (err instanceof AssistantEditError || err instanceof SessionStreamingError) {
						return error(id, command.type, err.message, err.code);
					}
					throw err;
				}
			}

			case "edit_user_message": {
				if (
					typeof command.entryId !== "string" ||
					command.entryId.length === 0 ||
					typeof command.text !== "string"
				) {
					return error(id, command.type, "edit_user_message requires a non-empty entryId and a text string");
				}
				try {
					const result = await session.editUserMessage(command.entryId, command.text, {
						summarize: command.summarize,
						customInstructions: command.customInstructions,
						expectedLeafId: command.expectedLeafId,
					});
					const leafId = session.sessionManager.getLeafId();
					if (result.unchanged) {
						return success(id, command.type, { outcome: "unchanged", leafId });
					}
					if (result.cancelled) {
						return success(id, command.type, {
							outcome: "cancelled",
							leafId,
							...(result.aborted ? { aborted: true } : {}),
						});
					}
					const entry = result.entryId ? session.sessionManager.getEntry(result.entryId) : undefined;
					if (entry?.type !== "message" || leafId === null) {
						return error(id, command.type, "Edited user entry was not persisted");
					}
					return success(id, command.type, {
						outcome: "edited",
						entry,
						leafId,
						...(result.summaryEntry ? { summaryEntryId: result.summaryEntry.id } : {}),
					});
				} catch (err) {
					if (
						err instanceof UserEditError ||
						err instanceof AssistantEditError ||
						err instanceof SessionStreamingError
					) {
						return error(id, command.type, err.message, err.code);
					}
					throw err;
				}
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (routingSessionId === undefined && !result.cancelled && session !== runtimeHost.session)
					await rebindAfterLocalReplacement();
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries":
				return answerGetEntries(session, command);

			case "get_tree": {
				const sessionManager = session.sessionManager;
				const tree = sessionManager.getTree();
				// getTree returns defensive nodes; keep the persisted entries diagnostic-bearing.
				const nodes = [...tree];
				for (const node of nodes) {
					node.entry = describeUsageLimitEntry(node.entry);
					for (const child of node.children) nodes.push(child);
				}
				session.releaseFullHistoryView();
				return success(id, "get_tree", { tree, leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "import_jsonl": {
				const result = await runtimeHost.importFromJsonl(command.inputPath, command.cwdOverride);
				if (routingSessionId === undefined && !result.cancelled && session !== runtimeHost.session)
					await rebindAfterLocalReplacement();
				return success(id, "import_jsonl", result);
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			case "record_user_activity": {
				// `prompt` activity is emitted by prompt admission itself; a client may only report a draft.
				// Read as unknown: the wire value is unchecked, whatever the declared command type says.
				const kind: unknown = command.kind;
				if (kind !== "draft") {
					return error(
						id,
						"record_user_activity",
						'record_user_activity: kind must be "draft"',
						RPC_ERROR_INVALID_ARGUMENT,
					);
				}
				session.recordUserActivity("draft");
				return success(id, "record_user_activity");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_subscription_limits": {
				return success(id, "get_subscription_limits", { accounts: subscriptionLimits.snapshot() });
			}

			case "get_messages": {
				return success(id, "get_messages", {
					messages: session.messages.map((message) =>
						message.role === "assistant" ? describeUsageLimitMessage(message) : message,
					),
				});
			}

			// On-demand fetch of a media block a `media_placeholders` client received as
			// an `image_ref` stub. Durable session entries first (they survive the live
			// message window being compacted away), then the live messages for a result
			// that has not been persisted yet.
			case "get_media": {
				const { toolCallId, contentIndex } = command;
				const content = findToolResultMedia(session, toolCallId, contentIndex);
				if (!content) {
					return error(id, "get_media", RPC_ERROR_MEDIA_NOT_FOUND, RPC_ERROR_MEDIA_NOT_FOUND);
				}
				return success(id, "get_media", { toolCallId, contentIndex, content });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				return success(id, "get_commands", { commands: buildRpcCommandsForSession(session) });
			}

			case "get_loaded_surfaces": {
				await requestMcpWireStatus();
				const inventory = recordLoadedSurfaces(true);
				return success(id, "get_loaded_surfaces", inventory.data);
			}

			case "extension_request":
			case "eval_cells.list":
			case "eval_cells.peek":
			case "eval_cells.stop": {
				const name = command.type === "extension_request" ? command.name.trim() : command.type;
				if (name.length === 0) return error(id, command.type, "Extension RPC request name cannot be empty");
				try {
					const data = await session.extensionRunner.requestRpc(
						name,
						command.type === "extension_request" ? command.data : command,
					);
					return success(id, command.type, data);
				} catch (cause) {
					if (
						cause instanceof ExtensionRpcRequestNotFoundError &&
						(name === "eval_cells.list" || name === "eval_cells.peek" || name === "eval_cells.stop")
					) {
						return error(
							id,
							command.type,
							"Eval cell controls are unavailable in this session",
							RPC_ERROR_EVAL_CELLS_UNAVAILABLE,
						);
					}
					if (
						cause instanceof Error &&
						"code" in cause &&
						(cause.code === RPC_ERROR_EVAL_CELL_NOT_FOUND || cause.code === RPC_ERROR_INVALID_EVAL_CELL_REQUEST)
					) {
						return error(id, command.type, cause.message, cause.code);
					}
					throw cause;
				}
			}

			// =================================================================
			// Auth (task 13)
			// =================================================================

			case "get_auth_providers": {
				const modelRegistry = session.modelRegistry;
				const oauthInfos = buildLoginProviderInfos(modelRegistry, "oauth");
				const apiKeyInfos = buildLoginProviderInfos(modelRegistry, "api_key");
				const providers: RpcAuthProvider[] = [...oauthInfos, ...apiKeyInfos].map((info) => {
					const origin = modelRegistry.getProviderOrigin(info.id);
					return {
						id: info.id,
						name: info.name,
						authType: info.authType,
						status: authMethodStatus(modelRegistry, info),
						...storedKeyHint(modelRegistry, info),
						...(origin === undefined ? {} : { origin }),
					};
				});
				return success(id, "get_auth_providers", { providers });
			}

			case "login_start": {
				// Respond IMMEDIATELY: success:true means the flow has started. The
				// URL and terminal result are delivered via auth_login_url /
				// auth_login_end events, because an interactive OAuth round-trip
				// cannot fit within the request timeout.
				void startLogin(command.provider);
				return success(id, "login_start");
			}

			case "login_cancel": {
				const controller = activeLogins.get(command.provider);
				controller?.abort();
				return success(id, "login_cancel");
			}

			case "login_api_key": {
				const replacement = session.modelRegistry.authStorage.set(command.provider, {
					type: "api_key",
					key: command.key,
				});
				// The response carries what this key replaced (senpi#3448). Consume the record before the
				// await below, so no record is pending across it and a concurrent OAuth login keeps its own (#3952).
				session.modelRegistry.authStorage.takeReplacement(command.provider);
				// Answer after the registry sees the key: a client re-reading auth status on this
				// response must not get the pre-login snapshot (#2384).
				await session.modelRegistry.refresh();
				return success(id, "login_api_key", replacement);
			}

			case "verify_api_key": {
				const verification = await verifyApiKey({
					models: session.modelRegistry.getAll(),
					provider: command.provider,
					key: command.key,
					signal: AbortSignal.timeout(15_000),
				});
				return success(id, "verify_api_key", verification);
			}

			case "logout": {
				session.modelRegistry.authStorage.logout(command.provider);
				await session.modelRegistry.refresh();
				return success(id, "logout");
			}

			case "get_provider_accounts": {
				const listing = await listCredentialAccounts(session.modelRegistry.authStorage, command.provider);
				return success(id, "get_provider_accounts", { accounts: listing.accounts, ordered: listing.ordered });
			}

			case "account_pin": {
				await pinCredentialAccount(session.modelRegistry.authStorage, command.provider, command.name);
				return success(id, "account_pin");
			}

			case "account_remove": {
				await removeCredentialAccount(session.modelRegistry.authStorage, command.provider, command.name);
				return success(id, "account_remove");
			}

			case "account_order": {
				const names: unknown = command.names;
				if (names !== null && !(Array.isArray(names) && names.every((name) => typeof name === "string"))) {
					throw new Error("account_order names must be an array of account names, or null to clear the order");
				}
				await orderCredentialAccounts(session.modelRegistry.authStorage, command.provider, command.names);
				return success(id, "account_order");
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	const handleInputLine = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRpcBackpressure();
			return;
		}

		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			output(error(undefined, "parse", shapeError));
			await waitForRpcBackpressure();
			return;
		}

		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_progress"
		) {
			questions.progress(parsed as RpcExtensionUIProgress);
			return;
		}

		if (isHostResponse(parsed)) {
			output(answerHostResponse(parsed, (frame) => relocation?.respond(frame) ?? "unknown"));
			return;
		}

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const requestId = answeredUiRequestId(parsed as RpcExtensionUIResponse);
			if (!options.workerSecurityBridge && requestId !== undefined && grantRequests.has(requestId)) {
				const sender = options.clientInfo?.connectionId();
				const capable =
					sender === undefined
						? clientCapabilities?.includes("grant_select") === true
						: options.clientInfo?.hasCapability?.(sender, "grant_select") === true;
				if (grantRequests.get(requestId) !== sender || !capable) return;
			}
			const reply = settleExtensionUiResponse(parsed as RpcExtensionUIResponse, {
				questions,
				dialogs: pendingExtensionRequests,
				routed: routingSessionId !== undefined,
				ledger: sessionUiAnswerLedger(session),
				// An answer is a person's input by its entry point, whatever the connection role.
				beforeAnswer: () => session.admitHumanAnswer(),
			});
			if (reply) output(reply);
			return;
		}

		const command = parsed as RpcCommand;
		const payloadError = rpcCommandPayloadError(command);
		const messageLengthError = rpcMessageLengthError(command);
		if (payloadError || messageLengthError) {
			output(error(command.id, command.type, payloadError ?? messageLengthError!));
			await waitForRpcBackpressure();
			return;
		}
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRpcBackpressure();
			}
		} catch (commandError: unknown) {
			const missingCwd =
				commandError instanceof Error && commandError.name === "MissingSessionCwdError" && "issue" in commandError;
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
					missingCwd ? "missing_session_cwd" : undefined,
					missingCwd ? commandError.issue : undefined,
				),
			);
			await waitForRpcBackpressure();
		}
	};

	// A single-session connection hears its account's new limit windows as they are reported. A host
	// session's handler (it has a routing `sessionId`) does not: the host broadcasts the record once.
	const stopLimitEvents =
		options.sessionId === undefined
			? subscriptionLimits.subscribe((limits) => outputEvent({ type: "subscription_limits", ...limits }))
			: () => {};
	const dispose = async (disposeOptions: { readonly processExit?: boolean } = {}): Promise<void> => {
		unbindMcpForms?.();
		grantPresentationAbort.abort();
		detachGrantPresentation?.();
		unsubscribeSecurityNotices?.();
		stopLimitEvents();
		sessionControl?.dispose();
		sessionControl = undefined;
		relocation?.dispose();
		relocation = undefined;
		questions.cancelAll();
		pendingExtensionRequests.close();
		unsubscribeProviderAccountEvents();
		unsubscribe?.();
		unsubscribeStructured?.();
		unsubscribeBackpressure?.();
		unsubscribeLoadedSurfaces?.();
		unsubscribeExtensionEvents?.();
		unsubscribe = undefined;
		unsubscribeStructured = undefined;
		unsubscribeBackpressure = undefined;
		unsubscribeLoadedSurfaces = undefined;
		unsubscribeExtensionEvents = undefined;
		if (options.disposeRuntime !== false) {
			await runtimeHost.dispose(disposeOptions);
		}
	};

	// Perform the initial bind synchronously-scheduled so the handler is ready
	// as soon as the caller awaits `ready`.
	let unbindMcpForms: (() => void) | undefined;
	const ready = rebindSession();

	return {
		ready,
		async handleInputLine(line: string) {
			await ready;
			await handleInputLine(line);
		},
		pendingPrompts() {
			return [...promptCalls];
		},
		isShutdownRequested() {
			return shutdownRequested;
		},
		cancelPendingExtensionUiRequests() {
			questions.cancelAll();
			pendingExtensionRequests.cancelAll();
		},
		connectionDetached(connectionId) {
			relocation?.connectionDetached(connectionId);
		},
		async dispose(disposeOptions) {
			await ready;
			await dispose(disposeOptions);
		},
	};
}
