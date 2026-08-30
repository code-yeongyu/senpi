import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { executeBashWithOperations } from "../../core/bash-executor.ts";
import type { ProjectTrustContext, ReplacedSessionContext } from "../../core/extensions/index.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { BashOperations } from "../../core/tools/bash.ts";
import { type EnsuredHost, ensureHost } from "../rpc/host-ensure.ts";
import { isTransportGoneError, RpcClient, type RpcClientEvent } from "../rpc/rpc-client.ts";

export const INTERACTIVE_HOST_FALLBACK_WARNING = "Warning: shared interactive host unavailable; continuing locally";
export const INTERACTIVE_HOST_RECONNECTING_WARNING = "Warning: shared interactive host connection lost; reconnecting";

export interface InteractiveHostWarning {
	readonly type: "interactive_host_fallback" | "interactive_host_action_failed";
	readonly message: string;
	readonly cause: unknown;
}

/**
 * The session contract InteractiveMode actually runs against. The local
 * AgentSession answers these reads synchronously; the shared-host proxy answers
 * them over RPC. Declaring the union here keeps the proxy honest (no more
 * `as unknown as` lie at the boundary) and lets the compiler find every TUI
 * call site that must await.
 */
export type InteractiveSession = Omit<
	AgentSession,
	"cycleThinkingLevel" | "getAvailableThinkingLevels" | "getSessionStats" | "getUserMessagesForForking"
> & {
	cycleThinkingLevel(): ThinkingLevel | undefined | Promise<ThinkingLevel | undefined>;
	getAvailableThinkingLevels(): ThinkingLevel[] | Promise<ThinkingLevel[]>;
	getSessionStats():
		| ReturnType<AgentSession["getSessionStats"]>
		| Promise<ReturnType<AgentSession["getSessionStats"]>>;
	getUserMessagesForForking():
		| ReturnType<AgentSession["getUserMessagesForForking"]>
		| Promise<ReturnType<AgentSession["getUserMessagesForForking"]>>;
};

export type InteractiveHostUiHandler = (
	request: import("../rpc/rpc-types.ts").RpcExtensionUIRequest,
) =>
	| Promise<import("../rpc/rpc-types.ts").RpcExtensionUIResponse | undefined>
	| import("../rpc/rpc-types.ts").RpcExtensionUIResponse
	| undefined;

export interface InteractiveHostRuntimeOptions {
	readonly socket: string;
	readonly agentDir?: string;
	readonly ensureHost?: (options: { socket: string; agentDir?: string }) => Promise<EnsuredHost | undefined>;
	onWarning?: (warning: InteractiveHostWarning) => void;
}

/**
 * Replace only the transport-facing session operations. The object returned is
 * deliberately still an AgentSessionRuntime: InteractiveMode and extensions
 * retain their existing runtime seam, while the authoritative prompt/session
 * state is hosted by the shared RPC process.
 */
export async function createInteractiveHostRuntime(
	localRuntime: AgentSessionRuntime,
	options: InteractiveHostRuntimeOptions,
): Promise<AgentSessionRuntime> {
	const sessionPath = localRuntime.session.sessionFile;
	if (!sessionPath) return localRuntime;
	const startHost = options.ensureHost ?? ((hostOptions) => ensureHost(hostOptions));
	let remoteSession: RemoteSessionProxy | undefined;
	let remoteRuntime: RemoteInteractiveRuntime | undefined;
	let reconnecting: Promise<void> | undefined;
	let disconnectQueued = false;
	let disposed = false;
	let fallbackWarned = false;
	let reconnectWarningShown = false;
	const warnReconnect = (cause: unknown) => {
		if (reconnectWarningShown) return;
		reconnectWarningShown = true;
		options.onWarning?.({
			type: "interactive_host_action_failed",
			message: INTERACTIVE_HOST_RECONNECTING_WARNING,
			cause,
		});
	};
	const warnFallback = (cause: unknown) => {
		if (fallbackWarned) return;
		fallbackWarned = true;
		options.onWarning?.({ type: "interactive_host_fallback", message: INTERACTIVE_HOST_FALLBACK_WARNING, cause });
	};
	let scheduleReconnect: () => void = () => {};
	const client = new RpcClient({
		socketPath: options.socket,
		onDisconnect: () => {
			disconnectQueued = true;
			scheduleReconnect();
		},
	});
	scheduleReconnect = () => {
		if (!remoteSession || reconnecting || disposed || remoteRuntime?.isFallback) return;
		remoteRuntime?.enterReconnecting();
		reconnecting = (async () => {
			let cause: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (disposed) return;
				disconnectQueued = false;
				try {
					await startHost({ socket: options.socket, agentDir: options.agentDir });
					if (disposed) return;
					await client.start();
					if (disposed) return;
					await client.openSession({ sessionPath, cwd: localRuntime.cwd });
					if (disposed) return;
					await remoteSession.refresh();
					if (disposed) return;
					fallbackWarned = false;
					reconnectWarningShown = false;
					remoteRuntime?.enterConnected();
					return;
				} catch (error) {
					cause = error;
					await client.stop().catch(() => {});
					if (disposed) return;
				}
			}
			if (!disposed) {
				await remoteRuntime?.enterFallback();
				warnFallback(cause);
			}
		})().finally(() => {
			reconnecting = undefined;
			if (disconnectQueued && !disposed && !remoteRuntime?.isFallback) scheduleReconnect();
		});
	};
	try {
		await startHost({ socket: options.socket, agentDir: options.agentDir });
		await client.start();
		const opened = await client.openSession({
			sessionPath,
			cwd: localRuntime.cwd,
			provider: localRuntime.session.model?.provider,
			modelId: localRuntime.session.model?.id,
			thinkingLevel: localRuntime.session.thinkingLevel,
		});
		remoteSession = createRemoteSessionProxy(
			localRuntime.session,
			localRuntime.services.agentDir,
			client,
			opened.state,
			options.onWarning,
			(cause) => {
				if (remoteRuntime?.isReconnecting) warnReconnect(cause);
				else warnFallback(cause);
			},
		);
		if (opened.state.isBashRunning && !opened.attached) {
			// Only a newly opened session can have an execution orphaned by a
			// previous connection. An attach is an observer of the same live runtime;
			// aborting it would cancel work owned by the surviving attachment.
			await client.abortBash().catch(() => {});
		}
		if (opened.attached) await remoteSession.refresh();
		remoteRuntime = new RemoteInteractiveRuntime(localRuntime, remoteSession, client, {
			onTransportGone: (cause) => {
				if (remoteRuntime?.isReconnecting) warnReconnect(cause);
				else warnFallback(cause);
			},
			get reconnecting() {
				return reconnecting;
			},
			dispose: () => {
				disposed = true;
			},
		});
		return remoteRuntime as unknown as AgentSessionRuntime;
	} catch (cause) {
		await client.stop().catch(() => {});
		warnFallback(cause);
		return localRuntime;
	}
}

export class RemoteInteractiveRuntime {
	readonly #local: AgentSessionRuntime;
	readonly #remoteSession: RemoteSessionProxy;
	readonly #client: RpcClient;
	readonly #lifecycle?: { readonly reconnecting: Promise<void> | undefined; readonly dispose: () => void };
	readonly #onTransportGone: (cause: unknown) => void;
	#rebindSession: (() => Promise<void>) | undefined;
	#beforeSessionInvalidate: (() => void) | undefined;
	#state: "connected" | "reconnecting" | "fallback" | "disposed" = "connected";
	#fallbackHandoff: Promise<void> | undefined;
	get isReconnecting(): boolean {
		return this.#state === "reconnecting";
	}
	get isFallback(): boolean {
		return this.#state === "fallback";
	}

	constructor(
		local: AgentSessionRuntime,
		remoteSession: RemoteSessionProxy,
		client: RpcClient,
		lifecycle?: { readonly reconnecting: Promise<void> | undefined; readonly dispose: () => void } & {
			onTransportGone: (cause: unknown) => void;
		},
	) {
		this.#local = local;
		this.#remoteSession = remoteSession;
		this.#client = client;
		this.#lifecycle = lifecycle;
		this.#onTransportGone = lifecycle?.onTransportGone ?? (() => {});
	}

	async #call<T>(call: () => Promise<T>): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (isTransportGoneError(error)) {
				this.#onTransportGone(error);
				return { cancelled: true } as T;
			}
			throw error;
		}
	}

	enterConnected(): void {
		if (this.#state !== "disposed" && this.#state !== "fallback") this.#state = "connected";
	}

	enterReconnecting(): void {
		if (this.#state !== "disposed" && this.#state !== "fallback") this.#state = "reconnecting";
	}

	async enterFallback(): Promise<void> {
		if (this.#state === "disposed" || this.#state === "fallback") return;
		this.#state = "fallback";
		this.#beforeSessionInvalidate?.();
		const rebind = this.#rebindSession?.();
		if (rebind) {
			this.#fallbackHandoff = rebind.catch((error) => {
				this.#onTransportGone(error);
			});
			await this.#fallbackHandoff;
		}
	}

	get session(): AgentSession {
		return this.#state === "fallback" || this.#state === "disposed"
			? this.#local.session
			: this.#remoteSession.session;
	}
	get services(): AgentSessionRuntime["services"] {
		return this.#local.services;
	}
	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}
	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.#local.diagnostics;
	}
	get modelFallbackMessage(): string | undefined {
		return this.#local.modelFallbackMessage;
	}
	get launchProfile(): AgentSessionRuntime["launchProfile"] {
		return this.#local.launchProfile;
	}
	setBeforeSessionInvalidate(callback?: () => void): void {
		this.#beforeSessionInvalidate = callback;
		this.#local.setBeforeSessionInvalidate(callback);
	}
	setRebindSession(callback?: () => Promise<void>): void {
		this.#rebindSession = callback;
		this.#local.setRebindSession(callback);
		if (callback && this.#state === "fallback" && !this.#fallbackHandoff) {
			this.#fallbackHandoff = callback().catch((error) => {
				this.#onTransportGone(error);
			});
		}
	}
	setHostUiHandler(callback?: InteractiveHostUiHandler): void {
		this.#remoteSession.setHostUiHandler(callback);
	}
	async dispose(): Promise<void> {
		if (this.#state === "disposed") return;
		this.#state = "disposed";
		this.#lifecycle?.dispose();
		await this.#lifecycle?.reconnecting?.catch(() => {});
		await this.#fallbackHandoff?.catch(() => {});
		const errors: unknown[] = [];
		for (const cleanup of [
			() => this.#remoteSession.abortLocalBash(),
			() => this.#client.closeSession(),
			() => this.#client.stop(),
			() => this.#local.dispose(),
		]) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw errors[0];
	}
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		if (this.#state === "fallback") return this.#local.newSession(options);
		// Suppresses for the ENTIRE command, not just the refresh tail: a
		// multi-session host emits session_replaced while completing it, so the echo
		// can arrive before the refresh/rebind sequence below starts and race it -
		// newSession transports setup entries between two refreshes.
		return this.#remoteSession
			.aroundLocalReplacement(async () => {
				const result = await this.#call(() => this.#client.newSession(options?.parentSession));
				if (!result.cancelled) {
					this.#beforeSessionInvalidate?.();
					this.#remoteSession.abortLocalBash();
					await this.#remoteSession.refresh();
					if (options?.setup) {
						const capture = SessionManager.inMemory(this.#remoteSession.session.sessionManager.getCwd());
						await options.setup(capture);
						for (const entry of capture.getEntries()) await this.#client.appendSessionEntry(entry);
						await this.#remoteSession.refresh();
					}
					await this.#rebindSession?.();
					if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
				}
				return result;
			})
			.catch((error) => {
				if (isTransportGoneError(error)) return { cancelled: true };
				throw error;
			});
	}
	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		if (this.#state === "fallback") return this.#local.switchSession(sessionPath, options);
		// See newSession: the suppression must cover the command itself, since the
		// host emits session_replaced while completing it.
		return this.#remoteSession
			.aroundLocalReplacement(async () => {
				const result = await this.#call(() =>
					this.#client.switchSession(
						sessionPath,
						options?.cwdOverride === undefined ? undefined : { cwdOverride: options.cwdOverride },
					),
				);
				if (!result.cancelled) {
					this.#beforeSessionInvalidate?.();
					this.#remoteSession.abortLocalBash();
					await this.#remoteSession.refresh();
					await this.#rebindSession?.();
					// The shared host already resolved trust; this callback is retained for
					// compatibility, but its result cannot override host-authoritative state.
					options?.projectTrustContextFactory?.(this.#remoteSession.session.sessionManager.getCwd());
					if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
				}
				return result;
			})
			.catch((error) => {
				if (isTransportGoneError(error)) return { cancelled: true };
				throw error;
			});
	}
	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		if (this.#state === "fallback") return this.#local.fork(entryId, options);
		// See newSession: the suppression must cover the command itself.
		return this.#remoteSession
			.aroundLocalReplacement(async () => {
				const result = await this.#call(() => this.#client.fork(entryId, options));
				if (!result.cancelled) {
					this.#beforeSessionInvalidate?.();
					this.#remoteSession.abortLocalBash();
					await this.#refreshAndRebind();
					if (options?.withSession) await options.withSession(this.#remoteSession.createReplacedSessionContext());
				}
				return { cancelled: result.cancelled, selectedText: result.text };
			})
			.catch((error) => {
				if (isTransportGoneError(error)) return { cancelled: true };
				throw error;
			});
	}
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		if (this.#state === "fallback") return this.#local.importFromJsonl(inputPath, cwdOverride);
		// See newSession: the suppression must cover the command itself.
		return this.#remoteSession
			.aroundLocalReplacement(async () => {
				const result = await this.#call(() => this.#client.importJsonl(inputPath, cwdOverride));
				if (!result.cancelled) {
					this.#beforeSessionInvalidate?.();
					this.#remoteSession.abortLocalBash();
					await this.#refreshAndRebind();
				}
				return result;
			})
			.catch((error) => {
				if (isTransportGoneError(error)) return { cancelled: true };
				throw error;
			});
	}

	async #refreshAndRebind(): Promise<void> {
		await this.#remoteSession.refresh();
		await this.#rebindSession?.();
	}
}

interface RemoteSessionProxy {
	readonly session: AgentSession;
	setHostUiHandler(callback?: InteractiveHostUiHandler): void;
	refresh(): Promise<void>;
	/**
	 * Run a replacement this runtime is driving itself, suppressing the refresh
	 * that the host's broadcast `session_replaced` would otherwise trigger. The
	 * caller owns the refresh/rebind ordering for its own replacements, so the
	 * scope must cover the command itself, not just its refresh tail.
	 */
	aroundLocalReplacement<T>(body: () => Promise<T>): Promise<T>;
	abortLocalBash(): void;
	createReplacedSessionContext(): ReplacedSessionContext;
}

/** Exported for direct coverage of the wire-event handling below. */
export function createRemoteSessionProxy(
	local: AgentSession,
	agentDir: string,
	client: RpcClient,
	initialState: ReturnType<typeof stateFromRpc>,
	onWarning?: (warning: InteractiveHostWarning) => void,
	onTransportGone?: (cause: unknown) => void,
): RemoteSessionProxy {
	// Fire-and-forget setters keep the sync AgentSession signature, but their RPC
	// failures must not vanish: the matching *_changed wire event confirms success,
	// and a rejection here is the only signal of failure.
	const reportActionFailure = (action: string) => (error: unknown) => {
		const transportGone = isTransportGoneError(error);
		if (transportGone) onTransportGone?.(error);
		else
			onWarning?.({
				type: "interactive_host_action_failed",
				message: `Warning: shared interactive host ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
				cause: error,
			});
	};
	const transportCall = async <T>(action: string, call: () => Promise<T>, cancelledValue?: T): Promise<T> => {
		try {
			return await call();
		} catch (error) {
			if (!isTransportGoneError(error)) throw error;
			reportActionFailure(action)(error);
			return cancelledValue as T;
		}
	};
	let state = { ...initialState };
	const waitForBashCallbacks = async (promises: Set<Promise<void>>, allowAbandonment: boolean): Promise<boolean> => {
		if (promises.size === 0) return true;
		const settled = Promise.allSettled([...promises]).then(() => true);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const bounded = new Promise<false>((resolve) => {
			timeout = setTimeout(resolve, allowAbandonment ? 100 : 5_000, false);
			timeout.unref?.();
		});
		try {
			return await Promise.race([settled, bounded]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};
	const executionNamespace = randomUUID();
	const cleanupRemoteBashOutput = async (path: string): Promise<void> => {
		let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				client.cleanupBashOutput(path),
				new Promise<never>((_, reject) => {
					cleanupTimeout = setTimeout(() => reject(new Error("RPC cleanup timed out")), 1_000);
				}),
			]);
			return;
		} catch (transportError) {
			// Spill paths are shared host filesystem paths. If the RPC transport is
			// already unavailable, remove locally as a bounded best-effort fallback;
			// a later reconnect is not required to prevent this callback failure from
			// permanently leaking the host-owned artifact.
			try {
				await rm(path, { force: true });
				return;
			} catch (localError) {
				onWarning?.({
					type: "interactive_host_action_failed",
					message: `Warning: failed to clean up shared bash output spill: ${localError instanceof Error ? localError.message : String(localError)}`,
					cause: new AggregateError([transportError, localError]),
				});
			}
		} finally {
			if (cleanupTimeout) clearTimeout(cleanupTimeout);
		}
	};
	let nextBashExecutionId = 0;
	const bashExecutions = new Map<
		string,
		{
			chunk?: (chunk: string) => void | PromiseLike<void>;
			promises: Set<Promise<void>>;
			error: unknown;
			hasError: boolean;
		}
	>();
	let hostUiHandler: InteractiveHostUiHandler | undefined;
	const pendingUiRequests: import("../rpc/rpc-types.ts").RpcExtensionUIRequest[] = [];
	let localBashAbortController: AbortController | undefined;
	let localBashRunning = false;
	let hostBashRunning = initialState.isBashRunning;
	let nextQueuedInputOrder = Math.max(0, ...initialState.ordered.map((item) => item.enqueueOrder));
	let sessionManager = local.sessionManager;
	let settingsManager = SettingsManager.create(initialState.cwd, agentDir, {
		projectTrusted: initialState.projectTrusted,
	});
	const updateBashState = () => {
		state = { ...state, isBashRunning: localBashRunning || hostBashRunning };
	};
	const remoteSessionManager = new Proxy({} as SessionManager, {
		get(_target, property, _receiver) {
			if (property === "appendLabelChange") {
				return (entryId: string, label?: string) =>
					void client.setLabel(entryId, label).catch(reportActionFailure("appendLabelChange"));
			}
			if (property === "getCwd") return () => state.cwd;
			if (property === "getSessionName") return () => state.sessionName;
			if (property === "getUsageTotals") return () => state.usageTotals;
			const value = Reflect.get(sessionManager, property, sessionManager);
			return typeof value === "function" ? value.bind(sessionManager) : value;
		},
	});
	let streamingAssistant: Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined;
	let mirroredCurrentAssistantUsage = false;
	/** Non-zero while this runtime is driving its own replacement sequence. */
	let localReplacementDepth = 0;
	const listeners = new Set<AgentSessionEventListener>();
	client.onEvent((wireEvent) => {
		if ((wireEvent as { type?: string }).type === "extension_ui_request") {
			const request = wireEvent as import("../rpc/rpc-types.ts").RpcExtensionUIRequest;
			if (hostUiHandler)
				void Promise.resolve(hostUiHandler(request))
					.then((response) => response && client.sendExtensionUIResponse(response))
					.catch(reportActionFailure("host UI response"));
			else pendingUiRequests.push(request);
			return;
		}
		if (wireEvent.type === "session_replaced") {
			// The host swapped the live session behind this connection - another
			// attached client issued the replacement, or an extension drove one that no
			// client issued. Nothing else re-reads the binding, so without this the
			// proxy keeps serving the previous session's manager, settings and message
			// mirror while the host has already moved on. The command response carries
			// only `{ cancelled }`, so this event is the only signal available here.
			//
			// A multi-session host broadcasts the event to every connection including
			// the one that issued the replacement, and this runtime's own replacement
			// methods already run an ordered refresh/rebind - newSession additionally
			// transports setup entries between two refreshes. Refreshing again from
			// here would race that sequence, so self-driven replacements are skipped.
			if (localReplacementDepth === 0) {
				void refresh().catch(reportActionFailure("session refresh after replacement"));
			}
			return;
		}
		if (wireEvent.type === "agent_settled") state = { ...state, isStreaming: false, retryAttempt: 0 };
		if (wireEvent.type === "bash_start") {
			hostBashRunning = true;
			updateBashState();
		}
		if (wireEvent.type === "bash_end") {
			hostBashRunning = false;
			updateBashState();
		}
		if (wireEvent.type === "bash_execution_update" && wireEvent.id) {
			const execution = bashExecutions.get(wireEvent.id);
			if (execution?.chunk && !execution.hasError) {
				try {
					const callbackPromise = Promise.resolve(execution.chunk(wireEvent.delta)).catch((error) => {
						if (!execution.hasError) {
							execution.error = error;
							execution.hasError = true;
							void client.abortBash().catch(() => {});
						}
						throw error;
					});
					execution.promises.add(callbackPromise);
					void callbackPromise.catch(() => {}).finally(() => execution.promises.delete(callbackPromise));
				} catch (error) {
					if (!execution.hasError) {
						execution.error = error;
						execution.hasError = true;
						void client.abortBash().catch(() => {});
					}
				}
			}
		}
		if (wireEvent.type === "agent_start") state = { ...state, isStreaming: true };
		if (wireEvent.type === "compaction_start") state = { ...state, isCompacting: true };
		if (wireEvent.type === "compaction_end") state = { ...state, isCompacting: false };
		if (wireEvent.type === "auto_retry_start") state = { ...state, retryAttempt: wireEvent.attempt };
		if (wireEvent.type === "auto_retry_end") state = { ...state, retryAttempt: 0 };
		if (wireEvent.type === "queue_update") {
			nextQueuedInputOrder = Math.max(nextQueuedInputOrder, ...wireEvent.ordered.map((item) => item.enqueueOrder));
			state = {
				...state,
				steering: [...wireEvent.steering],
				followUp: [...wireEvent.followUp],
				ordered: [...wireEvent.ordered],
				pendingMessageCount: wireEvent.steering.length + wireEvent.followUp.length,
			};
		}
		if (wireEvent.type === "model_changed") {
			state = { ...state, model: wireEvent.model, thinkingLevel: wireEvent.thinkingLevel };
		}
		if (wireEvent.type === "thinking_level_changed") state = { ...state, thinkingLevel: wireEvent.level };
		if (wireEvent.type === "service_tier_changed") {
			state = { ...state, serviceTier: wireEvent.tier, fastMode: wireEvent.fastMode };
		}
		if (wireEvent.type === "session_settings_changed") {
			state = {
				...state,
				steeringMode: wireEvent.steeringMode,
				followUpMode: wireEvent.followUpMode,
				autoCompactionEnabled: wireEvent.autoCompactionEnabled,
			};
		}
		if (wireEvent.type === "entry_appended") {
			try {
				sessionManager.appendEntry(wireEvent.entry);
				local.agent.state.messages = sessionManager.buildSessionContext().messages;
			} catch {
				// Non-fatal if the local snapshot cannot accept a concurrent entry.
			}
		}
		if (wireEvent.type === "session_info_changed") state = { ...state, sessionName: wireEvent.name };
		if (wireEvent.type === "message_start") {
			if (wireEvent.message.role === "assistant") {
				streamingAssistant = structuredClone(wireEvent.message);
				mirroredCurrentAssistantUsage = false;
			}
			local.agent.state.messages.push(structuredClone(wireEvent.message));
		}
		if (wireEvent.type === "message_end") {
			if (wireEvent.message.role === "assistant") {
				streamingAssistant = structuredClone(wireEvent.message);
				const usage = wireEvent.message.usage;
				if (usage && !mirroredCurrentAssistantUsage) {
					mirroredCurrentAssistantUsage = true;
					const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
					const contextWindow = state.model?.contextWindow ?? 0;
					const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
					state = {
						...state,
						contextUsage:
							contextWindow > 0
								? { tokens: contextTokens, contextWindow, percent: (contextTokens / contextWindow) * 100 }
								: undefined,
						usageTotals: {
							...state.usageTotals,
							input: state.usageTotals.input + usage.input,
							output: state.usageTotals.output + usage.output,
							cacheRead: state.usageTotals.cacheRead + usage.cacheRead,
							cacheWrite: state.usageTotals.cacheWrite + usage.cacheWrite,
							cost: state.usageTotals.cost + (usage.cost?.total ?? 0),
							latestCacheHitRate:
								latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined,
						},
					};
				}
			}
			const messages = local.agent.state.messages;
			const previous = messages.at(-1);
			if (previous?.role === wireEvent.message.role)
				messages[messages.length - 1] = structuredClone(wireEvent.message);
		}
		if (wireEvent.type === "compaction_end" && wireEvent.accepted && !wireEvent.aborted) {
			try {
				local.sessionManager.reloadFromDisk?.();
				if (sessionManager !== local.sessionManager) sessionManager.reloadFromDisk?.();
				local.agent.state.messages = sessionManager.buildSessionContext().messages;
			} catch {
				// Non-fatal if session file is transiently locked or unavailable
			}
		}
		const event = hydrateMessageUpdate(wireEvent, streamingAssistant);
		for (const listener of listeners) listener(event);
	});
	const performRefresh = async (): Promise<void> => {
		// Captured before the first await: entries that arrive via `entry_appended`
		// while this refresh is in flight are newer than the snapshot it reconciles
		// against, and must survive the rebuild below.
		const idsAtRefreshStart = new Set(sessionManager.getEntries().map((entry) => entry.id));
		const nextState = await transportCall("refresh", () => client.getState());
		if (!nextState) return;
		state = { ...stateFromRpc(nextState) };
		nextQueuedInputOrder = Math.max(0, ...nextState.ordered.map((item) => item.enqueueOrder));
		let messages: AgentSession["messages"];
		settingsManager = SettingsManager.create(nextState.cwd, agentDir, {
			projectTrusted: nextState.projectTrusted,
		});
		if (nextState.sessionFile) {
			// Keep the caller-owned manager identity when refreshing the same session.
			// Navigation and host-side mutations must update every existing mirror, not
			// leave the interactive runtime holding the pre-refresh snapshot.
			if (sessionManager.getSessionFile() === nextState.sessionFile) {
				sessionManager.reloadFromDisk?.();
			} else {
				// SessionManager.open retains the explicit path even when the host has
				// deferred creating the file for a setup-only session.
				sessionManager = SessionManager.open(nextState.sessionFile, undefined, nextState.cwd);
			}
			// The host ships its complete entry list while the session file is still
			// deferred (no assistant message yet, so nothing has been written), which
			// makes that list the only authoritative view of the session. Reconcile the
			// mirror to it exactly: `entry_appended` notifications that cross a
			// concurrent refresh land on whichever manager is current, so the mirror
			// can hold an arbitrary partial set rather than a prefix, and a snapshot
			// taken mid-bind can simply be short. Backfilling only an empty mirror
			// wedged it at whatever partial set it happened to hold.
			const authoritative = nextState.entries;
			if (authoritative?.length) {
				const mirror = sessionManager.getEntries();
				const matches =
					mirror.length === authoritative.length &&
					mirror.every((entry, index) => entry.id === authoritative[index]?.id);
				if (!matches) {
					const rebuilt = SessionManager.open(nextState.sessionFile, undefined, nextState.cwd);
					for (const entry of authoritative) rebuilt.appendEntry(entry);
					// A notification that crossed this refresh refers to an entry the
					// snapshot predates, so it is newer than the snapshot; dropping it
					// would strand the entry until an unrelated refresh happened to
					// run. Keep it, in arrival order, after the authoritative list.
					const authoritativeIds = new Set(authoritative.map((entry) => entry.id));
					for (const entry of mirror) {
						if (!idsAtRefreshStart.has(entry.id) && !authoritativeIds.has(entry.id)) {
							rebuilt.appendEntry(entry);
						}
					}
					sessionManager = rebuilt;
				}
			}
			messages = sessionManager.buildSessionContext().messages;
		} else {
			messages = await transportCall("refresh", () => client.getMessages(), []);
		}
		local.agent.state.messages.splice(0, local.agent.state.messages.length, ...structuredClone(messages));
		streamingAssistant = undefined;
	};
	// Refreshes must not interleave: each one reassigns sessionManager,
	// settingsManager and the mirrored message list, so two in flight can commit a
	// mixed snapshot of two different sessions. A replacement-driven refresh races
	// exactly that way against a caller-driven one, so run them in order.
	let refreshChain: Promise<void> = Promise.resolve();
	const refresh = (): Promise<void> => {
		const next = refreshChain.then(performRefresh, performRefresh);
		refreshChain = next.then(
			() => {},
			() => {},
		);
		return next;
	};
	const session = new Proxy(local, {
		get(target, property, receiver) {
			if (property === "prompt")
				return async (message: string, options?: Parameters<AgentSession["prompt"]>[1]) => {
					try {
						await client.prompt(message, {
							...(options?.images ? { images: options.images } : {}),
							...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
							...(options?.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
							...(options?.sessionTitlePrompt !== undefined
								? { sessionTitlePrompt: options.sessionTitlePrompt }
								: {}),
							...(options?.expandPromptTemplates !== undefined
								? { expandPromptTemplates: options.expandPromptTemplates }
								: {}),
							...(options?.promptDisposition ? { promptDisposition: options.promptDisposition } : {}),
							...(options?.preflightResult ? { preflightResult: options.preflightResult } : {}),
						});
					} catch (error) {
						if (!isTransportGoneError(error)) throw error;
						reportActionFailure("prompt")(error);
					}
				};
			if (property === "abort") return () => client.abort();
			if (property === "abortCompaction")
				return () => void client.abortCompaction().catch(reportActionFailure("abortCompaction"));
			if (property === "steer")
				return (
					message: string,
					images?: Parameters<AgentSession["steer"]>[1],
					recovery?: { enqueueOrder?: number },
				) => {
					const enqueueOrder =
						recovery?.enqueueOrder ?? Math.max(0, ...state.ordered.map((item) => item.enqueueOrder)) + 1;
					state = {
						...state,
						steering: [...state.steering, message],
						ordered: [...state.ordered, { text: message, mode: "steer", enqueueOrder }],
						pendingMessageCount: state.pendingMessageCount + 1,
					};
					return transportCall("steer", () => client.steer(message, images, { ...recovery, enqueueOrder }));
				};
			if (property === "followUp")
				return (
					message: string,
					images?: Parameters<AgentSession["followUp"]>[1],
					recovery?: { enqueueOrder?: number },
				) => {
					const enqueueOrder =
						recovery?.enqueueOrder ?? Math.max(0, ...state.ordered.map((item) => item.enqueueOrder)) + 1;
					state = {
						...state,
						followUp: [...state.followUp, message],
						ordered: [...state.ordered, { text: message, mode: "followUp", enqueueOrder }],
						pendingMessageCount: state.pendingMessageCount + 1,
					};
					return transportCall("followUp", () => client.followUp(message, images, { ...recovery, enqueueOrder }));
				};
			if (property === "waitForIdle") return () => client.waitForIdle();
			if (property === "getLastAssistantText") return () => target.getLastAssistantText();
			if (property === "setModel" || property === "setSessionModel")
				return async (model: NonNullable<AgentSession["model"]>) => {
					const next = await transportCall("setModel", () => client.setModel(model.provider, model.id), undefined);
					return next ? { systemPromptName: next.systemPromptName, model: next } : undefined;
				};
			if (property === "setSessionThinkingLevel")
				return (level: AgentSession["thinkingLevel"]) =>
					void client
						.setThinkingLevel(level, { scope: "turn" })
						.catch(reportActionFailure("setSessionThinkingLevel"));
			if (property === "setSessionFastMode")
				return (enabled: boolean) =>
					void client.setFastMode(enabled).catch(reportActionFailure("setSessionFastMode"));
			if (property === "abortRetry") return () => void client.abortRetry().catch(reportActionFailure("abortRetry"));
			if (property === "setAutoRetryEnabled")
				return (enabled: boolean) =>
					void client.setAutoRetry(enabled).catch(reportActionFailure("setAutoRetryEnabled"));
			if (property === "reserveQueuedInputOrder") return () => ++nextQueuedInputOrder;
			if (property === "setFavoriteModels")
				return (models: Parameters<AgentSession["setFavoriteModels"]>[0]) => {
					state = { ...state, favoriteModels: [...models] };
					void client.setFavoriteModels(models).catch(reportActionFailure("setFavoriteModels"));
				};
			if (property === "setScopedModels")
				return (models: Parameters<AgentSession["setScopedModels"]>[0]) => {
					state = { ...state, scopedModels: [...models] };
					void client.setScopedModels(models).catch(reportActionFailure("setScopedModels"));
				};
			if (property === "cycleModel")
				return (direction?: "forward" | "backward") =>
					transportCall("cycleModel", () => client.cycleModel(direction), undefined);
			if (property === "setThinkingLevel")
				return (level: AgentSession["thinkingLevel"]) =>
					void client.setThinkingLevel(level).catch(reportActionFailure("setThinkingLevel"));
			if (property === "cycleThinkingLevel")
				return () =>
					transportCall("cycleThinkingLevel", () => client.cycleThinkingLevel(), undefined).then(
						(result) => result?.level,
					);
			if (property === "getAvailableThinkingLevels")
				return () => transportCall("getAvailableThinkingLevels", () => client.getAvailableThinkingLevels(), []);
			if (property === "setSteeringMode")
				return (mode: AgentSession["steeringMode"]) =>
					void client.setSteeringMode(mode).catch(reportActionFailure("setSteeringMode"));
			if (property === "setFollowUpMode")
				return (mode: AgentSession["followUpMode"]) =>
					void client.setFollowUpMode(mode).catch(reportActionFailure("setFollowUpMode"));
			if (property === "compact")
				return (instructions?: string) => transportCall("compact", () => client.compact(instructions));
			if (property === "setAutoCompactionEnabled")
				return (enabled: boolean) =>
					void client.setAutoCompaction(enabled).catch(reportActionFailure("setAutoCompaction"));
			if (property === "executeBash")
				return async (
					command: string,
					onChunk?: (chunk: string) => void | PromiseLike<void>,
					options?: { excludeFromContext?: boolean; operations?: BashOperations | Record<string, unknown> },
				) => {
					if (options?.operations && typeof options.operations.exec === "function") {
						const abortController = new AbortController();
						localBashAbortController = abortController;
						localBashRunning = true;
						updateBashState();
						const sessionAtStart = state.sessionId;
						const prefix = settingsManager.getShellCommandPrefix();
						const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
						try {
							const result = await executeBashWithOperations(
								resolvedCommand,
								state.cwd,
								options.operations as BashOperations,
								{ onChunk, signal: abortController.signal },
							);
							if (state.sessionId === sessionAtStart) {
								await transportCall("recordBashResult", () =>
									client.recordBashResult(command, result, options.excludeFromContext),
								);
							}
							return result;
						} finally {
							localBashAbortController = undefined;
							localBashRunning = false;
							updateBashState();
						}
					}
					const executionId = `bash-${executionNamespace}-${++nextBashExecutionId}`;
					const execution = {
						chunk: onChunk,
						promises: new Set<Promise<void>>(),
						error: undefined as unknown,
						hasError: false,
					};
					bashExecutions.set(executionId, execution);
					try {
						const result = await transportCall(
							"bash",
							() =>
								client.bash(command, {
									excludeFromContext: options?.excludeFromContext,
									executionId,
									operations: options?.operations as Record<string, unknown> | undefined,
								}),
							{ output: "", exitCode: undefined, cancelled: true, truncated: false },
						);
						const callbacksSettled = await waitForBashCallbacks(execution.promises, false);
						if (!callbacksSettled) {
							if (result.fullOutputPath) await cleanupRemoteBashOutput(result.fullOutputPath);
							throw new Error("Bash output callback did not settle within 5000ms");
						}
						if (execution.hasError) {
							if (result.fullOutputPath) await cleanupRemoteBashOutput(result.fullOutputPath);
							throw execution.error;
						}
						return result;
					} finally {
						bashExecutions.delete(executionId);
					}
				};
			if (property === "abortBash")
				return () => {
					if (localBashAbortController) localBashAbortController.abort();
					else void client.abortBash().catch(reportActionFailure("abortBash"));
				};
			if (property === "getContextUsage") return () => state.contextUsage;
			if (property === "getSessionStats")
				return () => transportCall("getSessionStats", () => client.getSessionStats(), local.getSessionStats());
			if (property === "exportToHtml")
				return (outputPath?: string, options?: { themeName?: string }) =>
					transportCall("exportToHtml", () => client.exportHtml(outputPath, options?.themeName)).then(
						(result) => result?.path,
					);
			if (property === "setSessionName")
				return (name: string) => client.setSessionName(name).catch(reportActionFailure("setSessionName"));
			if (property === "navigateTree")
				return async (targetId: string, options?: Parameters<AgentSession["navigateTree"]>[1]) => {
					const result = await transportCall("navigateTree", () => client.navigateTree(targetId, options), {
						cancelled: true,
					});
					if (!result.cancelled) await refresh();
					return result;
				};
			if (property === "getUserMessagesForForking")
				return () => transportCall("getUserMessagesForForking", () => client.getForkMessages(), []);
			if (property === "subscribe")
				return (listener: AgentSessionEventListener) => {
					listeners.add(listener);
					const localUnsubscribe = target.subscribe(listener);
					return () => {
						listeners.delete(listener);
						localUnsubscribe();
					};
				};
			if (property === "isStreaming") return state.isStreaming;
			if (property === "isIdle") return !state.isStreaming;
			if (property === "isCompacting") return state.isCompacting;
			if (property === "pendingMessageCount") return state.pendingMessageCount;
			if (property === "getSteeringMessages") return () => state.steering;
			if (property === "getFollowUpMessages") return () => state.followUp;
			if (property === "clearQueue")
				return (options?: { abortWillFollow: boolean }) => {
					const result = {
						steering: [...state.steering],
						followUp: [...state.followUp],
						ordered: [...state.ordered],
					};
					Object.defineProperty(result, "ordered", { value: result.ordered, enumerable: false });
					void client.clearQueue(options).catch(reportActionFailure("clearQueue"));
					return result;
				};
			if (property === "abortBranchSummary")
				return () => void client.abortBranchSummary().catch(reportActionFailure("abortBranchSummary"));
			if (property === "recordBashResult")
				return (
					command: string,
					result: Parameters<AgentSession["recordBashResult"]>[1],
					options?: { excludeFromContext?: boolean },
				) =>
					void client
						.recordBashResult(command, result, options?.excludeFromContext)
						.catch(reportActionFailure("recordBashResult"));
			if (property === "set_label") return undefined;
			if (property === "retryAttempt") return state.retryAttempt;
			if (property === "isBashRunning") return state.isBashRunning;
			if (property === "reload")
				return (_options?: Parameters<AgentSession["reload"]>[0]) =>
					transportCall("reload", () => client.reload(), { cancelled: true });
			if (property === "checkReloadVeto")
				return () => transportCall("checkReloadVeto", () => client.checkReloadVeto(), { cancelled: true });
			if (property === "exportToJsonl")
				return (outputPath?: string) =>
					transportCall("exportToJsonl", () => client.exportJsonl(outputPath)).then((result) => result?.path);
			// The footer and other renderers read session.state.*; surface the
			// host-authoritative fields there too, not only via the direct getters.
			if (property === "state") {
				const localState = target.state;
				return {
					...localState,
					model: state.model ?? localState.model,
					thinkingLevel: state.thinkingLevel,
					isStreaming: state.isStreaming,
					isCompacting: state.isCompacting,
				};
			}
			if (property === "sessionFile") return state.sessionFile;
			if (property === "sessionId") return state.sessionId;
			if (property === "sessionName") return state.sessionName;
			if (property === "serviceTier") return state.serviceTier;
			if (property === "steeringMode") return state.steeringMode;
			if (property === "followUpMode") return state.followUpMode;
			if (property === "autoCompactionEnabled") return state.autoCompactionEnabled;
			if (property === "isFastModeActive") return () => state.fastMode;
			if (property === "sessionManager") return remoteSessionManager;
			if (property === "settingsManager") return settingsManager;
			if (property === "messages") return target.messages;
			if (property === "favoriteModels") return state.favoriteModels;
			if (property === "scopedModels") return state.scopedModels;
			if (property === "model") return state.model ?? target.model;
			if (property === "thinkingLevel") return state.thinkingLevel;
			return Reflect.get(target, property, receiver);
		},
	});
	return {
		session,
		setHostUiHandler: (callback) => {
			hostUiHandler = callback;
			if (callback)
				for (const request of pendingUiRequests.splice(0))
					void Promise.resolve(callback(request))
						.then((response) => response && client.sendExtensionUIResponse(response))
						.catch(reportActionFailure("host UI response"));
		},
		refresh,
		aroundLocalReplacement: async (body) => {
			localReplacementDepth++;
			try {
				return await body();
			} finally {
				localReplacementDepth--;
			}
		},
		abortLocalBash: () => localBashAbortController?.abort(),
		createReplacedSessionContext: () => {
			const context = local.createReplacedSessionContext();
			Object.defineProperty(context, "cwd", { value: state.cwd });
			Object.defineProperty(context, "sessionManager", { value: remoteSessionManager });
			context.sendMessage = (message, options) =>
				transportCall("sendMessage", () =>
					client.sendCustomMessage(message, {
						triggerTurn: options?.triggerTurn,
						deliverAs: options?.deliverAs,
					}),
				);
			context.sendUserMessage = (content, options) => {
				if (typeof content === "string")
					return transportCall("sendUserMessage", () =>
						client.prompt(content, {
							streamingBehavior: options?.deliverAs,
							expandPromptTemplates: options?.expandPromptTemplates,
						}),
					);
				const text = content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const images = content.filter((part) => part.type === "image");
				return transportCall("sendUserMessage", () =>
					client.prompt(text, {
						images,
						streamingBehavior: options?.deliverAs,
						expandPromptTemplates: options?.expandPromptTemplates,
					}),
				);
			};
			return context;
		},
	};
}

function hydrateMessageUpdate(
	event: RpcClientEvent,
	streamingAssistant: Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined,
): AgentSessionEvent {
	if (event.type !== "message_update" || !streamingAssistant) return event as unknown as AgentSessionEvent;
	const update = event.assistantMessageEvent;
	if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
		return event as unknown as AgentSessionEvent;
	}
	const content = streamingAssistant.content[update.contentIndex];
	if (update.type === "text_delta" && content?.type === "text") content.text += update.delta;
	if (update.type === "thinking_delta" && content?.type === "thinking") content.thinking += update.delta;
	if (update.type === "toolcall_delta" && content?.type === "toolCall") {
		const raw = JSON.stringify(content.arguments) + update.delta;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				content.arguments = parsed as Record<string, unknown>;
			}
		} catch {
			// Keep the last valid arguments until the next complete update.
		}
	}
	streamingAssistant.usage = event.usage;
	return {
		type: "message_update",
		message: structuredClone(streamingAssistant),
		assistantMessageEvent: { ...update, partial: structuredClone(streamingAssistant) },
	} as AgentSessionEvent;
}

function stateFromRpc(state: {
	model?: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	isStreaming: boolean;
	isCompacting: boolean;
	pendingMessageCount: number;
	usageTotals: import("../../core/session-manager.ts").UsageTotals;
	contextUsage?: import("../../core/extensions/types.ts").ContextUsage;
	retryAttempt: number;
	isBashRunning: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	cwd: string;
	projectTrusted: boolean;
	serviceTier?: AgentSession["serviceTier"];
	fastMode: boolean;
	steeringMode: AgentSession["steeringMode"];
	followUpMode: AgentSession["followUpMode"];
	autoCompactionEnabled: boolean;
	entries?: import("../../core/session-manager.ts").SessionEntry[];
	favoriteModels: import("../rpc/rpc-types.ts").RpcSessionModelEntry[];
	scopedModels: import("../rpc/rpc-types.ts").RpcSessionModelEntry[];
	steering: string[];
	followUp: string[];
	ordered: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number }>;
}) {
	return state;
}

export function isInteractiveHostEvent(event: RpcClientEvent): event is Extract<RpcClientEvent, { type: string }> {
	return typeof event === "object" && event !== null && "type" in event;
}
