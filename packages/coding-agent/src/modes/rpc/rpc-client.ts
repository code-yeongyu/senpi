/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { PromptDisposition, SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { ServiceTier } from "../../core/extensions/builtin/service-tier.ts";
import { MissingSessionCwdError } from "../../core/session-cwd.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcAccountFailoverEvent,
	RpcAuthAccountsChangedEvent,
	RpcCommand,
	RpcExtensionEvent,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcProviderAccount,
	RpcResponse,
	RpcSessionModelEntry,
	RpcSessionReplacedEvent,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Connect to an existing multi-session Unix socket instead of spawning a child. */
	socketPath?: string;
	/** Called once when an established transport disconnects. */
	onDisconnect?: (error: RpcTransportGoneError) => void;
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
	supportedThinkingLevels?: ThinkingLevel[];
}

type PromptOptions = {
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	thinkingLevel?: ThinkingLevel;
	promptDisposition?: (disposition: PromptDisposition) => void;
	preflightResult?: (success: boolean) => void;
	sessionTitlePrompt?: string | false;
	expandPromptTemplates?: boolean;
};

export type RpcProviderAccountEvent = RpcAuthAccountsChangedEvent | RpcAccountFailoverEvent;
export type RpcClientEvent =
	| JsonAgentSessionEvent
	| RpcProviderAccountEvent
	| RpcExtensionEvent
	| RpcExtensionUIRequest
	// The host swapped the live session behind this connection. Part of the public
	// union so a typed client can discriminate on the type and read the new
	// `durableSessionId` without casting: the command response carries only
	// `{ cancelled }`, and a replacement may be driven by another client or an
	// extension, so this is the only channel delivering the new identity.
	| RpcSessionReplacedEvent
	| { type: "bash_start" }
	| { type: "bash_end" };
export type RpcEventListener = (event: RpcClientEvent) => void;

function isProviderAccountEvent(event: RpcClientEvent): event is RpcProviderAccountEvent {
	return event.type === "auth_accounts_changed" || event.type === "account_failover";
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcTransportGoneError extends Error {
	readonly code = "rpc_transport_gone" as const;

	constructor(message = "Shared RPC host is unavailable") {
		super(message);
		this.name = "RpcTransportGoneError";
	}
}

export function isTransportGoneError(error: unknown): error is RpcTransportGoneError {
	return (
		error instanceof RpcTransportGoneError ||
		(error instanceof Error &&
			(error.message === "Client not started" ||
				error.message.startsWith("RPC transport is not writable.") ||
				error.message === "RPC socket closed"))
	);
}

export class RpcClientOpenInFlightError extends Error {
	readonly code = "open_session_in_flight" as const;

	constructor() {
		super("An open_session request is already in flight");
		this.name = "RpcClientOpenInFlightError";
	}
}

// Keep pre-lease startup delivery bounded by both record count and wire size.
const MAX_PENDING_SESSION_EVENTS = 512;
const MAX_PENDING_SESSION_EVENT_BYTES = 1024 * 1024;

export class RpcClient {
	private process: ChildProcess | null = null;
	private socket: Socket | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<
		string,
		{
			resolve: (response: RpcResponse) => void;
			reject: (error: Error) => void;
			onResponse?: (response: RpcResponse) => void;
			onReject?: (error: Error) => void;
		}
	> = new Map();
	private requestId = 0;
	private sessionId: string | undefined;
	private pendingOpenSession = false;
	private pendingSessionEvents: Array<{ sessionId: string; event: RpcClientEvent; bytes: number }> = [];
	private pendingSessionEventBytes = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private disconnectNotified = false;
	private stopping = false;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process || this.socket) {
			throw new Error("Client already started");
		}

		this.exitError = null;
		this.stopping = false;
		this.disconnectNotified = false;
		if (this.options.socketPath) {
			await this.startSocket(this.options.socketPath);
			return;
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			// Callers may be console-less on win32 (GUI hosts, detached daemons), and a
			// console-subsystem child would then allocate a fresh visible terminal window.
			windowsHide: true,
		});
		this.process = childProcess;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		this.pendingOpenSession = false;
		this.pendingSessionEvents = [];
		this.pendingSessionEventBytes = 0;
		if (this.socket) {
			this.stopping = true;
			this.stopReadingStdout?.();
			this.stopReadingStdout = null;
			this.socket.destroy();
			this.socket = null;
			this.sessionId = undefined;
			this.pendingOpenSession = false;
			this.pendingSessionEvents = [];
			this.notifyDisconnect(new RpcTransportGoneError());
			return;
		}
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
	}

	private async startSocket(path: string): Promise<void> {
		const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(path)) : undefined;
		const socket = createConnection(resolveSocketTransportAddress(path, process.platform, secret));
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				this.socket = null;
				reject(error);
			};
			const cleanup = () => {
				socket.off("connect", onConnect);
				socket.off("error", onError);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});
		if (secret) sendSocketHandshake(socket, secret);
		this.stopReadingStdout = attachJsonlLineReader(socket, (line) => this.handleLine(line));
		socket.once("close", () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.notifyDisconnect(new RpcTransportGoneError());
		});
		socket.once("error", (error) => {
			if (this.socket !== socket) return;
			this.notifyDisconnect(new RpcTransportGoneError());
			void error;
		});
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	async setClientInfo(width: number, capabilities?: string[]): Promise<void> {
		await this.send({ type: "set_client_info", width, capabilities }, this.sessionId !== undefined);
	}

	async openSession(options: {
		sessionPath?: string;
		cwd?: string;
		provider?: string;
		modelId?: string;
		thinkingLevel?: ThinkingLevel;
		permissionPreset?: string;
	}): Promise<{ sessionId: string; state: RpcSessionState; attached?: boolean }> {
		if (this.pendingOpenSession) throw new RpcClientOpenInFlightError();
		this.pendingOpenSession = true;
		try {
			const response = await this.send({ type: "open_session", ...options }, false);
			const opened = this.getData<{ sessionId: string; state: RpcSessionState; attached?: boolean }>(response);
			this.sessionId = opened.sessionId;
			this.pendingOpenSession = false;
			this.flushPendingSessionEvents();
			return opened;
		} catch (error) {
			this.pendingOpenSession = false;
			this.pendingSessionEvents = [];
			this.pendingSessionEventBytes = 0;
			throw error;
		}
	}

	async sendExtensionUIResponse(response: RpcExtensionUIResponse): Promise<void> {
		await this.send(response, true, undefined, false);
	}

	async closeSession(sessionId = this.sessionId): Promise<void> {
		if (!sessionId) return;
		try {
			await this.send({ type: "close_session", sessionId }, false);
		} catch (error) {
			if (!isTransportGoneError(error)) throw error;
		}
		if (this.sessionId === sessionId) this.sessionId = undefined;
	}

	async listSessions(): Promise<
		Array<{
			sessionId: string;
			durableSessionId?: string;
			sessionPath?: string;
			cwd: string;
			name?: string;
			status: "opening" | "open" | "closing" | "closed";
		}>
	> {
		const response = await this.send({ type: "list_sessions" }, false);
		return this.getData<{
			sessions: Array<{
				sessionId: string;
				durableSessionId?: string;
				sessionPath?: string;
				cwd: string;
				name?: string;
				status: "opening" | "open" | "closing" | "closed";
			}>;
		}>(response).sessions;
	}

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 *
	 * The disposition/preflight callbacks mirror AgentSession's local prompt contract:
	 * they fire synchronously while the response frame is dispatched — before any
	 * queued message_start event — so optimistic-echo eligibility is settled in wire
	 * order. A success response without a disposition (older host) maps to "handled"
	 * so the echo degrades to canonical-only rendering instead of double-rendering.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void>;
	async prompt(message: string, options?: PromptOptions): Promise<void>;
	async prompt(message: string, optionsOrImages?: PromptOptions | ImageContent[]): Promise<void> {
		const options: PromptOptions = Array.isArray(optionsOrImages)
			? { images: optionsOrImages }
			: (optionsOrImages ?? {});
		const response = await this.send(
			{
				type: "prompt",
				message,
				...(options.images ? { images: options.images } : {}),
				...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
				...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
				...(options.sessionTitlePrompt !== undefined ? { sessionTitlePrompt: options.sessionTitlePrompt } : {}),
				...(options.expandPromptTemplates !== undefined
					? { expandPromptTemplates: options.expandPromptTemplates }
					: {}),
			},
			true,
			{
				onResponse: (wireResponse) => {
					if (!wireResponse.success) {
						options?.preflightResult?.(false);
						return;
					}
					const data = (wireResponse as { data?: { disposition?: PromptDisposition } }).data;
					options?.promptDisposition?.(data?.disposition ?? "handled");
					options?.preflightResult?.(true);
				},
				onReject: () => {
					options?.preflightResult?.(false);
				},
			},
		);
		if (!response.success) {
			throw new Error((response as Extract<RpcResponse, { success: false }>).error);
		}
	}

	async appendUserMessage(content: unknown): Promise<void> {
		await this.send({ type: "append_user_message", content });
	}

	async appendSessionEntry(entry: import("../../core/session-manager.ts").SessionEntry): Promise<void> {
		await this.send({ type: "append_session_entry", entry });
	}

	async sendCustomMessage<T = unknown>(
		message: { customType: string; content: unknown; display: boolean; details?: T },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		await this.send({ type: "send_custom_message", ...message, ...options });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[], recovery?: { enqueueOrder?: number }): Promise<void> {
		await this.send({ type: "steer", message, images, enqueueOrder: recovery?.enqueueOrder });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[], recovery?: { enqueueOrder?: number }): Promise<void> {
		await this.send({ type: "follow_up", message, images, enqueueOrder: recovery?.enqueueOrder });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		try {
			await this.send({ type: "abort" });
		} catch (error) {
			if (!isTransportGoneError(error)) throw error;
		}
	}

	async abortCompaction(): Promise<void> {
		await this.send({ type: "abort_compaction" });
	}

	async reload(): Promise<{ cancelled: boolean; reason?: string }> {
		const response = await this.send({ type: "reload" });
		return this.getData(response);
	}

	async checkReloadVeto(): Promise<{ cancelled: boolean; reason?: string }> {
		const response = await this.send({ type: "check_reload_veto" });
		return this.getData(response);
	}

	/**
	 * Clear queued steering and follow-up messages, returning their text.
	 */
	async clearQueue(options?: { abortWillFollow?: boolean }): Promise<{
		steering: string[];
		followUp: string[];
		ordered: Array<{ text: string; mode: "steer" | "followUp"; enqueueOrder: number }>;
	}> {
		const response = await this.send({ type: "clear_queue", abortWillFollow: options?.abortWillFollow });
		return this.getData(response);
	}

	async getSteeringMessages(): Promise<string[]> {
		const response = await this.send({ type: "get_steering_messages" });
		return this.getData<{ messages: string[] }>(response).messages;
	}

	async getFollowUpMessages(): Promise<string[]> {
		const response = await this.send({ type: "get_follow_up_messages" });
		return this.getData<{ messages: string[] }>(response).messages;
	}

	async abortBranchSummary(): Promise<void> {
		await this.send({ type: "abort_branch_summary" });
	}

	async recordBashResult(command: string, result: BashResult, excludeFromContext?: boolean): Promise<void> {
		await this.send({ type: "record_bash_result", command, result, excludeFromContext });
	}

	async setLabel(entryId: string, label?: string): Promise<void> {
		await this.send({ type: "set_label", entryId, label });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(
		provider: string,
		modelId: string,
	): Promise<{ provider: string; id: string; systemPromptName?: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async setFavoriteModels(models: RpcSessionModelEntry[]): Promise<void> {
		await this.send({ type: "set_favorite_models", models });
	}

	async setScopedModels(models: RpcSessionModelEntry[]): Promise<void> {
		await this.send({ type: "set_scoped_models", models });
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model", direction });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 *
	 * `scope: "turn"` changes only this session's level without rewriting the model's remembered
	 * level; it throws when the active model does not support the requested level, and the
	 * session keeps the level it already had.
	 */
	async setThinkingLevel(level: ThinkingLevel, options?: { scope?: "turn" }): Promise<void> {
		const response = await this.send({ type: "set_thinking_level", level, scope: options?.scope });
		if (!response.success) {
			throw new Error((response as Extract<RpcResponse, { success: false }>).error);
		}
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Turn OpenAI Codex fast mode (the `priority` service tier) on or off for the active model.
	 *
	 * The choice is remembered per model, so a later session on the same model starts the same
	 * way. Throws when the request is refused: a non-Codex model, or an active `:priority` model
	 * pin that fast mode must not undo.
	 */
	async setFastMode(
		enabled: boolean,
	): Promise<{ enabled: boolean; serviceTier: ServiceTier; provider: string; modelId: string }> {
		const response = await this.send({ type: "set_fast_mode", enabled });
		return this.getData(response);
	}

	/** Current fast-mode state and the service tier requests would carry. */
	async getFastMode(): Promise<{ enabled: boolean; serviceTier: ServiceTier | null }> {
		const response = await this.send({ type: "get_fast_mode" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(
		command: string,
		options?: { excludeFromContext?: boolean; executionId?: string; operations?: Record<string, unknown> },
	): Promise<BashResult> {
		const response = await this.send({
			type: "bash",
			command,
			excludeFromContext: options?.excludeFromContext,
			executionId: options?.executionId,
			operations: options?.operations,
		});
		return this.getData(response);
	}

	async navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean; editorText?: string; aborted?: boolean; summaryEntry?: unknown }> {
		const response = await this.send({ type: "navigate_tree", targetId, ...options });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	async cleanupBashOutput(path: string): Promise<void> {
		await this.send({ type: "cleanup_bash_output", path });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string, themeName?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath, themeName });
		return this.getData(response);
	}

	async exportJsonl(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_jsonl", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string, options?: { cwdOverride?: string }): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath, cwdOverride: options?.cwdOverride });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(
		entryId: string,
		options?: { position?: "before" | "at" },
	): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId, position: options?.position });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	async importJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "import_jsonl", inputPath, cwdOverride });
		return this.getData(response);
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/** Invoke one extension-owned RPC request handler and return its structured result. */
	async requestExtension<T = unknown>(name: string, data?: unknown): Promise<T> {
		const response = await this.send({
			type: "extension_request",
			name,
			...(data === undefined ? {} : { data }),
		});
		return this.getData<T>(response);
	}

	/** List safe metadata for the named provider's configured account slots. */
	async getProviderAccounts(provider: string): Promise<RpcProviderAccount[]> {
		const response = await this.send({ type: "get_provider_accounts", provider });
		return this.getData<{ accounts: RpcProviderAccount[] }>(response).accounts;
	}

	/** Pin a provider account for future session-affine requests, or clear the pin. */
	async pinProviderAccount(provider: string, name: string | null): Promise<void> {
		await this.send({ type: "account_pin", provider, name });
	}

	/** Remove a persisted provider account slot. Environment slots are read-only. */
	async removeProviderAccount(provider: string, name: string): Promise<void> {
		await this.send({ type: "account_remove", provider, name });
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (
					isProviderAccountEvent(event) ||
					event.type === "extension_event" ||
					event.type === "bash_start" ||
					event.type === "bash_end" ||
					event.type === "extension_ui_request" ||
					// Connection-level, not part of the agent's event stream.
					event.type === "session_replaced"
				)
					return;
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images ? { images } : undefined);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// Check if it's a response to a pending request
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				this.pendingRequests.delete(data.id);
				// Response hooks run synchronously inside the frame dispatch so ordering-sensitive
				// contracts (e.g. optimistic-echo disposition) settle before the NEXT frame —
				// never through the microtask scheduled by resolve().
				pending.onResponse?.(data as RpcResponse);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Otherwise it's an event. During open_session, retain tagged events until
			// the response establishes the lease so startup hooks are not lost.
			if (typeof data.sessionId === "string" && data.sessionId !== this.sessionId) {
				if (this.pendingOpenSession) {
					const bytes = Buffer.byteLength(line);
					this.pendingSessionEvents.push({ sessionId: data.sessionId, event: data as RpcClientEvent, bytes });
					this.pendingSessionEventBytes += bytes;
					while (
						this.pendingSessionEvents.length > MAX_PENDING_SESSION_EVENTS ||
						this.pendingSessionEventBytes > MAX_PENDING_SESSION_EVENT_BYTES
					) {
						const oldest = this.pendingSessionEvents.shift();
						if (!oldest) break;
						this.pendingSessionEventBytes -= oldest.bytes;
					}
				}
				return;
			}
			for (const listener of this.eventListeners) {
				listener(data as RpcClientEvent);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private flushPendingSessionEvents(): void {
		const pending = this.pendingSessionEvents;
		this.pendingSessionEvents = [];
		this.pendingSessionEventBytes = 0;
		for (const { sessionId, event } of pending) {
			if (sessionId !== this.sessionId) continue;
			for (const listener of this.eventListeners) listener(event);
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private notifyDisconnect(error: RpcTransportGoneError): void {
		this.rejectPendingRequests(error);
		if (!this.disconnectNotified && !this.stopping) {
			this.disconnectNotified = true;
			this.options.onDisconnect?.(error);
		}
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.onReject?.(error);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private async send(
		command: RpcCommandBody | RpcExtensionUIResponse,
		route = true,
		hooks?: { onResponse?: (response: RpcResponse) => void; onReject?: (error: Error) => void },
		expectResponse = true,
	): Promise<RpcResponse> {
		const childProcess = this.process;
		const stream = this.socket ?? childProcess?.stdin;
		if (!stream) {
			throw new RpcTransportGoneError();
		}
		if (this.exitError) {
			throw this.exitError;
		}
		if (childProcess?.exitCode !== null && childProcess?.exitCode !== undefined) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (stream.destroyed || !stream.writable) {
			const error = new RpcTransportGoneError();
			this.notifyDisconnect(error);
			throw error;
		}

		const id = "type" in command && command.type === "extension_ui_response" ? command.id : `req_${++this.requestId}`;
		const fullCommand = {
			...command,
			...(route && this.sessionId && !("sessionId" in command) ? { sessionId: this.sessionId } : {}),
			...(command.type === "extension_ui_response" ? {} : { id }),
		} as RpcCommand;

		if (!expectResponse) {
			stream.write(serializeJsonLine(fullCommand));
			return Promise.resolve({ type: "response", command: command.type, success: true } as RpcResponse);
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				const timeoutError = new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`);
				pending?.onReject?.(timeoutError);
				reject(timeoutError);
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
				...(hooks?.onResponse ? { onResponse: hooks.onResponse } : {}),
				...(hooks?.onReject ? { onReject: hooks.onReject } : {}),
			});

			try {
				stream.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.onReject?.(writeError);
				pending?.reject(writeError);
			}
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			if (errorResponse.errorCode === "missing_session_cwd" && errorResponse.errorData) {
				throw new MissingSessionCwdError(
					errorResponse.errorData as ConstructorParameters<typeof MissingSessionCwdError>[0],
				);
			}
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
