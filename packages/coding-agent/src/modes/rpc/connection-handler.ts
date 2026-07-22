/**
 * Per-connection RPC handler.
 *
 * This is the transport-independent core extracted from `runRpcMode`. It owns
 * exactly one AgentSession runtime and speaks the JSONL RPC protocol over an
 * injected output sink and a caller-driven line feed. It knows nothing about
 * `process.stdout`, `process.stdin`, or process signals — those belong to the
 * host (classic single-connection stdio in `rpc-mode.ts`, or one socket
 * connection in the neo daemon).
 *
 * Behaviour is byte-for-byte identical to the original `runRpcMode` command
 * loop: the same responses, the same event stream, the same extension-UI
 * bridge, the same backpressure discipline. The only difference is that writes
 * go to `sink.writeRaw` instead of `writeRawStdout`, and the caller decides how
 * (and whether) to end the process.
 */

import * as crypto from "node:crypto";
import type { OAuthProviderId } from "@earendil-works/pi-ai/compat";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { buildLoginProviderInfos } from "../../core/auth-providers.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { buildCustomUnsupportedRequest, DEFAULT_CUSTOM_EXTENSION_LABEL } from "./custom-capability.ts";
import { createRpcEventOutputBuffer } from "./event-output-buffer.ts";
import type {
	RpcAuthProvider,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

/** Additive per-connection options. Absent = classic default (byte-identical). */
export interface RpcConnectionOptions {
	/** Client capability flags from the handshake (e.g. custom_unsupported opt-in). */
	capabilities?: readonly string[];
}

/**
 * The output side of a connection. `writeRaw` receives already-serialized JSONL
 * text (LF-terminated). `waitForBackpressure` lets the host apply flow control
 * (stdout drain in classic mode, socket `drain` in the daemon).
 */
export interface RpcConnectionSink {
	writeRaw(chunk: string): void;
	waitForBackpressure(): Promise<void>;
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
	 * True once an extension requested shutdown via the shutdown handler. The
	 * host polls this after each command and decides how to tear down.
	 */
	isShutdownRequested(): boolean;
	/** Tear down subscriptions and dispose the runtime. Never calls process.exit. */
	dispose(): Promise<void>;
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
	const clientCapabilities = options.capabilities;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	const eventOutput = createRpcEventOutputBuffer(sink.writeRaw);

	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		eventOutput.writeImmediate(obj);
	};

	const outputEvent = (event: object) => {
		eventOutput.enqueueEvent(event);
	};

	const waitForRpcBackpressure = async (): Promise<void> => {
		eventOutput.flushEvents();
		await sink.waitForBackpressure();
	};

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// Pending extension UI requests waiting for response
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

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
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * Create an extension UI context that uses the RPC protocol.
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
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
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
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
			// (so neo can render a "requires the classic TUI" dialog) before
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

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
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
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = session.subscribe((event) => {
			outputEvent(event);
		});
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRpcBackpressure();
		});
	};

	/**
	 * Drive an OAuth login for one provider as fire-command-then-subscribe.
	 *
	 * Reuses AuthStorage.login (the same callbacks the classic TUI uses). Only the
	 * URL-based happy path is surfaced over RPC: onAuth emits an auth_login_url
	 * event; success/failure/cancel emit a single auth_login_end event. Callbacks
	 * that need interactive mid-flow input (onPrompt/onSelect/onManualCodeInput)
	 * are not answerable in the event-only model, so they reject cleanly — the
	 * neo client uses the browser/callback-server completion path. Secrets are
	 * never emitted: only the provider id, the auth URL, and a success flag (plus a
	 * non-secret error message) cross the wire.
	 */
	const startLogin = async (provider: string): Promise<void> => {
		// A second login_start for the same provider aborts the prior attempt.
		activeLogins.get(provider)?.abort();
		const controller = new AbortController();
		activeLogins.set(provider, controller);

		const rejectInteractive = (): never => {
			throw new Error("Interactive login input is not supported over RPC");
		};

		try {
			await session.modelRegistry.authStorage.login(provider as OAuthProviderId, {
				onAuth: (info) => {
					outputEvent({ type: "auth_login_url", provider, url: info.url });
				},
				onDeviceCode: (info) => {
					outputEvent({ type: "auth_login_url", provider, url: info.verificationUri });
				},
				onPrompt: async () => rejectInteractive(),
				onSelect: async () => rejectInteractive(),
				onProgress: () => {},
				signal: controller.signal,
			});
			session.modelRegistry.refresh();
			outputEvent({ type: "auth_login_end", provider, success: true });
		} catch (loginError: unknown) {
			const message = loginError instanceof Error ? loginError.message : String(loginError);
			outputEvent({ type: "auth_login_end", provider, success: false, error: message });
		} finally {
			if (activeLogins.get(provider) === controller) {
				activeLogins.delete(provider);
			}
		}
	};

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Start prompt handling immediately, but emit the authoritative response only after
				// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const models = await session.modelRegistry.getAvailable();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = await session.modelRegistry.getAvailable();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				return success(id, "get_available_thinking_levels", { levels: session.getAvailableThinkingLevels() });
			}

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

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
				});
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// Commands (available for invocation via prompt)
			// =================================================================

			case "get_commands": {
				const commands: RpcSlashCommand[] = [];

				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			// =================================================================
			// Auth (task 13)
			// =================================================================

			case "get_auth_providers": {
				const modelRegistry = session.modelRegistry;
				const oauthInfos = buildLoginProviderInfos(modelRegistry, "oauth");
				const apiKeyInfos = buildLoginProviderInfos(modelRegistry, "api_key");
				const providers: RpcAuthProvider[] = [...oauthInfos, ...apiKeyInfos].map((info) => ({
					id: info.id,
					name: info.name,
					authType: info.authType,
					status: modelRegistry.getProviderAuthStatus(info.id),
				}));
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
				session.modelRegistry.authStorage.set(command.provider, { type: "api_key", key: command.key });
				session.modelRegistry.refresh();
				return success(id, "login_api_key");
			}

			case "logout": {
				session.modelRegistry.authStorage.logout(command.provider);
				session.modelRegistry.refresh();
				return success(id, "logout");
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

		// Handle extension UI responses
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				await waitForRpcBackpressure();
			}
		} catch (commandError: unknown) {
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRpcBackpressure();
		}
	};

	const dispose = async (): Promise<void> => {
		unsubscribe?.();
		unsubscribeBackpressure?.();
		unsubscribe = undefined;
		unsubscribeBackpressure = undefined;
		await runtimeHost.dispose();
	};

	// Perform the initial bind synchronously-scheduled so the handler is ready
	// as soon as the caller awaits `ready`.
	const ready = rebindSession();

	return {
		ready,
		async handleInputLine(line: string) {
			await ready;
			await handleInputLine(line);
		},
		isShutdownRequested() {
			return shutdownRequested;
		},
		async dispose() {
			await ready;
			await dispose();
		},
	};
}
