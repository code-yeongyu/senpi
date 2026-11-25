import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import {
	AcpClient,
	type AcpContentBlock,
	type AcpMcpServerConfig,
	type AcpPermissionRequest,
	type AcpPromptResult,
	AcpRpcError,
	type AcpSessionResult,
	type AcpSessionUpdateNotification,
	decidePermissionOutcome,
} from "./acp-client.ts";
import {
	type BridgeTool,
	newBridgeToken,
	registerBridgeSession,
	startBridgeServer,
	unregisterBridgeSession,
} from "./bridge-server.ts";
import { AGENT_NAME, BRIDGE_SERVER_NAME } from "./constants.ts";
import { agyChildEnvironment } from "./environment.ts";
import {
	extractConfigOptionValues,
	parseAgyAcpModels,
	rememberCatalogEntries,
	type ResolvedAgyModelTarget,
	resolveAgyModelTarget,
} from "./models.ts";
import { renderMessagesAsText } from "./prompt.ts";
import { type AntigravityAuthMethod, DEFAULT_ANTIGRAVITY_AUTH_METHOD } from "./settings.ts";
import { ToolCallQueue } from "./tool-bridge.ts";
import {
	type PreparedSessionWorkspace,
	prepareSessionWorkspace,
	pruneStaleSessionWorkspaces,
	removeSessionWorkspace,
	sessionWorkspaceRoot,
} from "./workspace.ts";

const IDLE_TIMEOUT_MS = 30 * 60_000;
const REAPER_INTERVAL_MS = 60_000;
const MAX_RESIDENT_SESSIONS = 32;
const KILL_GRACE_MS = 5_000;
const DEFAULT_HOLD_LIMIT_MS = 160_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 60_000;

export type AgySessionEvent =
	| { readonly type: "update"; readonly promptSeq: number; readonly notification: AcpSessionUpdateNotification }
	| { readonly type: "promptDone"; readonly promptSeq: number; readonly result: AcpPromptResult }
	| { readonly type: "promptError"; readonly promptSeq: number; readonly error: Error }
	| { readonly type: "exit"; readonly code: number | null };

export type AgySessionBinding = {
	readonly conversationId: string;
	readonly syncedCount: number;
	readonly prefixDigest: string;
	readonly modelId: string;
	readonly lastAssistantDigest?: string;
	readonly lastInputDigest?: string;
};

export type SeedBindingInput = AgySessionBinding;

export type PreparedAgySession = {
	readonly key: string;
	readonly bridgeUrl: string;
	readonly token: string;
	readonly workspace: PreparedSessionWorkspace;
};

export type StartAgySessionInput = {
	readonly prepared: PreparedAgySession;
	readonly executable: string;
	readonly acpArgs?: readonly string[];
	readonly modelId: string;
	readonly conversationId?: string;
	readonly tools: readonly BridgeTool[];
	readonly authMethod?: AntigravityAuthMethod;
	readonly holdLimitMs?: number;
	readonly cancelTimeoutMs?: number;
	readonly signal?: AbortSignal;
};

export type PrepareAgySessionInput = {
	readonly key: string;
	readonly agentDir: string;
	readonly systemPrompt: string;
	readonly projectCwd: string;
	readonly tools: readonly BridgeTool[];
};

export type ContinuityDecision = "resolve-tools" | "delta" | "reattach" | "bootstrap";

export type DecideContinuityInput = {
	readonly live: boolean;
	readonly modelMatches?: boolean;
	readonly fingerprintMatches?: boolean;
	readonly conversationId?: string;
	readonly prefixMatches: boolean;
	readonly resumeMode: "auto" | "off";
	readonly hasPendingCalls: boolean;
	readonly beginsWithPendingToolResult: boolean;
};

type QueueWaiter = {
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	readonly onAbort: () => void;
};

class SessionEventQueue {
	readonly #events: AgySessionEvent[] = [];
	readonly #waiters: QueueWaiter[] = [];

	push(event: AgySessionEvent): void {
		this.#events.push(event);
		for (const waiter of this.#waiters.splice(0)) {
			waiter.signal?.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(abortError(waiter.signal));
				continue;
			}
			waiter.resolve();
		}
	}

	whenAvailable(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (this.#events.length > 0) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const waiter: QueueWaiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.#waiters.indexOf(waiter);
					if (index < 0) return;
					this.#waiters.splice(index, 1);
					reject(abortError(signal));
				},
			};
			this.#waiters.push(waiter);
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}

	shift(): AgySessionEvent | undefined {
		return this.#events.shift();
	}
}

export type AgySession = {
	readonly key: string;
	readonly process: ChildProcessWithoutNullStreams;
	readonly client: AcpClient;
	readonly events: SessionEventQueue;
	readonly token: string;
	readonly queue: ToolCallQueue;
	readonly workspace: PreparedSessionWorkspace;
	readonly bridgeUrl: string;
	readonly authMethod: AntigravityAuthMethod | undefined;
	readonly holdLimitMs: number;
	readonly cancelTimeoutMs: number;
	conversationId: string | undefined;
	resumedFromConversation: boolean;
	modelId: string;
	activeConfigModel: string | undefined;
	activeThoughtLevel: string | undefined;
	advertisedConfigModels: string[] | undefined;
	advertisedThoughtLevels: string[] | undefined;
	systemPromptAppend: string;
	systemPromptHash: string;
	toolsHash: string;
	fingerprint: string;
	tools: BridgeTool[];
	syncedCount: number;
	prefixDigest: string;
	lastAssistantDigest: string | undefined;
	lastInputDigest: string | undefined;
	lastUsedAt: number;
	turnActive: boolean;
	promptSeq: number;
	activePrompt: Promise<AcpPromptResult> | undefined;
	holdTimer: ReturnType<typeof setTimeout> | undefined;
	exited: boolean;
	exitCode: number | null;
	killTimer: ReturnType<typeof setTimeout> | undefined;
};

const sessions = new Map<string, AgySession>();
const terminating = new Set<AgySession>();
const bindings = new Map<string, AgySessionBinding>();
let reaper: ReturnType<typeof setInterval> | undefined;
const WORKSPACE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
let lastWorkspaceRoot: string | undefined;
let lastWorkspacePruneAt = 0;

function maybePruneWorkspaces(rootDir: string, now = Date.now()): void {
	if (now - lastWorkspacePruneAt < WORKSPACE_PRUNE_INTERVAL_MS) return;
	lastWorkspacePruneAt = now;
	const activeDirs = new Set<string>();
	for (const session of sessions.values()) {
		activeDirs.add(session.workspace.dir);
	}
	pruneStaleSessionWorkspaces(rootDir, { activeDirs, now });
}

export function decideContinuity(input: DecideContinuityInput): ContinuityDecision {
	if (input.hasPendingCalls && input.beginsWithPendingToolResult) return "resolve-tools";
	if (input.live && input.prefixMatches) return "delta";
	if (input.conversationId !== undefined && input.resumeMode === "auto" && input.prefixMatches) return "reattach";
	return "bootstrap";
}

export function messagePrefixDigest(messages: readonly Message[]): string {
	return createHash("sha256").update(renderMessagesAsText(messages), "utf8").digest("hex");
}

export function assistantMessageDigest(message: Extract<Message, { role: "assistant" }>): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			parts.push(`T:${block.text}`);
		} else if (block.type === "toolCall") {
			parts.push(`C:${block.id}:${block.name}:${JSON.stringify(block.arguments)}`);
		}
	}
	return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

export function messageAnchorDigest(message: Message | undefined): string | undefined {
	if (message === undefined) return undefined;
	if (message.role === "assistant") return `A:${assistantMessageDigest(message)}`;
	if (message.role === "toolResult") {
		return createHash("sha256")
			.update(`R:${message.toolCallId}:${message.toolName}:${message.isError ? "1" : "0"}`, "utf8")
			.digest("hex");
	}
	if (message.role === "user") {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((b) => (b.type === "text" ? b.text : `[img:${b.data.length}]`)).join("\n");
		return createHash("sha256")
			.update(`U:${raw.slice(0, 4096)}:${raw.length}`, "utf8")
			.digest("hex");
	}
	return undefined;
}

export function findContinuationDeltaStart(
	messages: readonly Message[],
	binding: AgySessionBinding | undefined,
): number | undefined {
	if (binding === undefined || binding.syncedCount <= 0) return undefined;
	if (
		messages.length > binding.syncedCount &&
		messages[binding.syncedCount - 1]?.role === "assistant" &&
		messagePrefixDigest(messages.slice(0, binding.syncedCount - 1)) === binding.prefixDigest
	) {
		return binding.syncedCount;
	}
	if (binding.lastAssistantDigest !== undefined) {
		const floor = Math.max(0, messages.length - 24);
		for (let index = messages.length - 2; index >= floor; index -= 1) {
			const candidate = messages[index];
			if (candidate?.role !== "assistant") continue;
			if (assistantMessageDigest(candidate) !== binding.lastAssistantDigest) continue;
			if (
				binding.lastInputDigest === undefined ||
				(index > 0 && messageAnchorDigest(messages[index - 1]) === binding.lastInputDigest)
			) {
				return index + 1;
			}
		}
	}
	return undefined;
}

export function getSession(key: string): AgySession | undefined {
	return sessions.get(key);
}

export function getBinding(key: string): AgySessionBinding | undefined {
	const live = sessions.get(key);
	if (live?.conversationId !== undefined) {
		return {
			conversationId: live.conversationId,
			syncedCount: live.syncedCount,
			prefixDigest: live.prefixDigest,
			modelId: live.modelId,
			...(live.lastAssistantDigest !== undefined ? { lastAssistantDigest: live.lastAssistantDigest } : {}),
			...(live.lastInputDigest !== undefined ? { lastInputDigest: live.lastInputDigest } : {}),
		};
	}
	return bindings.get(key);
}

export async function prepareAgySession(input: PrepareAgySessionInput): Promise<PreparedAgySession> {
	const bridge = await startBridgeServer();
	const live = sessions.get(input.key);
	const token = live?.token ?? newBridgeToken();
	const rootDir = sessionWorkspaceRoot(input.agentDir);
	lastWorkspaceRoot = rootDir;
	maybePruneWorkspaces(rootDir);
	const workspace = prepareSessionWorkspace({
		rootDir,
		sessionKey: input.key,
		systemPrompt: input.systemPrompt,
		projectCwd: input.projectCwd,
		tools: input.tools,
	});
	return { key: input.key, bridgeUrl: bridge.url, token, workspace };
}

function mcpServersFor(bridgeUrl: string, token: string): AcpMcpServerConfig[] {
	return [
		{
			type: "http",
			name: BRIDGE_SERVER_NAME,
			url: bridgeUrl,
			headers: [{ name: "Authorization", value: `Bearer ${token}` }],
		},
	];
}

function applySessionMetadata(session: AgySession, result: AcpSessionResult): void {
	session.conversationId = result.sessionId;
	const modelOpt = extractConfigOptionValues(result.configOptions, "model");
	const thoughtOpt = extractConfigOptionValues(result.configOptions, "thought_level");
	if (modelOpt.values.length > 0) session.advertisedConfigModels = modelOpt.values;
	if (modelOpt.currentValue !== undefined) session.activeConfigModel = modelOpt.currentValue;
	if (thoughtOpt.values.length > 0) session.advertisedThoughtLevels = thoughtOpt.values;
	if (thoughtOpt.currentValue !== undefined) session.activeThoughtLevel = thoughtOpt.currentValue;
	const catalog = parseAgyAcpModels(result.models?.availableModels, result.configOptions);
	if (catalog.length > 0) rememberCatalogEntries(catalog);
}

export async function startAgySession(input: StartAgySessionInput): Promise<AgySession> {
	const prior = sessions.get(input.prepared.key);
	if (prior !== undefined) closeSession(prior.key, "replaced", { keepConversation: true });
	evictToCapacity();

	const args = input.acpArgs ? [...input.acpArgs] : ["acp", "--agent", AGENT_NAME, "--process-per-session"];
	const child = spawn(input.executable, args, {
		cwd: input.prepared.workspace.dir,
		env: agyChildEnvironment(process.env, { authMethod: input.authMethod }),
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});

	const stored = bindings.get(input.prepared.key);
	const queue = new ToolCallQueue();
	const events = new SessionEventQueue();
	let session!: AgySession;

	const client = new AcpClient(child, {
		onUpdate: (notification) => {
			if (
				session.conversationId !== undefined &&
				notification.sessionId !== undefined &&
				notification.sessionId !== session.conversationId
			) {
				return;
			}
			events.push({ type: "update", promptSeq: session.promptSeq, notification });
		},
		onServerRequest: (method, params) => {
			if (method === "session/request_permission") {
				return decidePermissionOutcome(params as AcpPermissionRequest).response;
			}
			throw new Error(`Unsupported ACP server request: ${method}`);
		},
		onExit: (code) => {
			session.exited = true;
			session.exitCode = code;
			clearHoldTimer(session);
			clearKillTimer(session);
			terminating.delete(session);
			events.push({ type: "exit", code });
		},
	});

	session = {
		key: input.prepared.key,
		process: child,
		client,
		events,
		token: input.prepared.token,
		queue,
		workspace: input.prepared.workspace,
		bridgeUrl: input.prepared.bridgeUrl,
		authMethod: input.authMethod,
		holdLimitMs: input.holdLimitMs ?? DEFAULT_HOLD_LIMIT_MS,
		cancelTimeoutMs: input.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS,
		conversationId: input.conversationId ?? stored?.conversationId,
		resumedFromConversation: false,
		modelId: input.modelId,
		activeConfigModel: undefined,
		activeThoughtLevel: undefined,
		advertisedConfigModels: undefined,
		advertisedThoughtLevels: undefined,
		systemPromptAppend: input.prepared.workspace.systemPromptAppend,
		systemPromptHash: input.prepared.workspace.systemPromptHash,
		toolsHash: input.prepared.workspace.toolsHash,
		fingerprint: input.prepared.workspace.fingerprint,
		tools: [...input.tools],
		syncedCount: stored?.syncedCount ?? 0,
		prefixDigest: stored?.prefixDigest ?? messagePrefixDigest([]),
		lastAssistantDigest: stored?.lastAssistantDigest,
		lastInputDigest: stored?.lastInputDigest,
		lastUsedAt: Date.now(),
		turnActive: false,
		promptSeq: 0,
		activePrompt: undefined,
		holdTimer: undefined,
		exited: false,
		exitCode: null,
		killTimer: undefined,
	};

	sessions.set(session.key, session);
	registerBridgeSession(session.token, {
		listTools: () => session.tools,
		callTool: (name, argsValue, signal) => session.queue.enqueue(name, argsValue, signal),
	});
	startReaper();

	try {
		await client.initialize({ timeoutMs: STARTUP_TIMEOUT_MS, signal: input.signal });
		const authMethod = input.authMethod ?? DEFAULT_ANTIGRAVITY_AUTH_METHOD;
		await client.authenticate(authMethod, { timeoutMs: STARTUP_TIMEOUT_MS, signal: input.signal });

		const mcpServers = mcpServersFor(input.prepared.bridgeUrl, input.prepared.token);
		let sessionRes: AcpSessionResult | undefined;
		if (input.conversationId !== undefined) {
			try {
				sessionRes = await client.resumeSession(
					{
						sessionId: input.conversationId,
						cwd: input.prepared.workspace.dir,
						mcpServers,
						systemPromptAppend: input.prepared.workspace.systemPromptAppend,
					},
					{ timeoutMs: STARTUP_TIMEOUT_MS, signal: input.signal },
				);
				session.resumedFromConversation = true;
			} catch (err) {
				if (input.signal?.aborted || session.exited) throw err;
				if (err instanceof AcpRpcError && err.code === -32000) throw err;
				session.resumedFromConversation = false;
			}
		}

		if (sessionRes === undefined) {
			sessionRes = await client.newSession(
				{
					cwd: input.prepared.workspace.dir,
					mcpServers,
					systemPromptAppend: input.prepared.workspace.systemPromptAppend,
				},
				{ timeoutMs: STARTUP_TIMEOUT_MS, signal: input.signal },
			);
			session.resumedFromConversation = false;
		}
		applySessionMetadata(session, sessionRes);
		return session;
	} catch (error) {
		closeSession(session.key, "startup_failed", { keepConversation: false });
		throw error;
	}
}

export async function refreshSessionConfig(
	session: AgySession,
	prepared: PreparedSessionWorkspace,
	tools: readonly BridgeTool[],
	signal?: AbortSignal,
): Promise<boolean> {
	if (session.systemPromptHash === prepared.systemPromptHash && session.toolsHash === prepared.toolsHash) {
		return true;
	}
	session.tools = [...tools];
	session.systemPromptAppend = prepared.systemPromptAppend;
	session.systemPromptHash = prepared.systemPromptHash;
	session.toolsHash = prepared.toolsHash;
	session.fingerprint = prepared.fingerprint;

	if (session.conversationId === undefined || session.exited) return false;
	try {
		await session.client.closeSession(session.conversationId, { timeoutMs: 10_000, signal });
		const resumed = await session.client.resumeSession(
			{
				sessionId: session.conversationId,
				cwd: session.workspace.dir,
				mcpServers: mcpServersFor(session.bridgeUrl, session.token),
				systemPromptAppend: prepared.systemPromptAppend,
			},
			{ timeoutMs: STARTUP_TIMEOUT_MS, signal },
		);
		applySessionMetadata(session, resumed);
		return true;
	} catch {
		return false;
	}
}

export async function configureSessionModel(
	session: AgySession,
	modelId: string,
	reasoning: Parameters<typeof resolveAgyModelTarget>[1],
	signal?: AbortSignal,
): Promise<ResolvedAgyModelTarget> {
	if (session.conversationId === undefined) {
		throw new Error("Antigravity ACP session has no conversationId.");
	}
	const target = resolveAgyModelTarget(modelId, reasoning, {
		advertisedConfigModels: session.advertisedConfigModels,
		advertisedThoughtLevels: session.advertisedThoughtLevels,
	});

	if (session.activeConfigModel !== target.configModelId) {
		const res = await session.client.setConfigOption(session.conversationId, "model", target.configModelId, {
			timeoutMs: 15_000,
			signal,
		});
		const modelOpt = extractConfigOptionValues(res.configOptions, "model");
		const thoughtOpt = extractConfigOptionValues(res.configOptions, "thought_level");
		if (modelOpt.values.length > 0) session.advertisedConfigModels = modelOpt.values;
		session.activeConfigModel = modelOpt.currentValue ?? target.configModelId;
		if (thoughtOpt.values.length > 0) session.advertisedThoughtLevels = thoughtOpt.values;
		if (thoughtOpt.currentValue !== undefined) session.activeThoughtLevel = thoughtOpt.currentValue;
	}

	const desiredThought =
		target.thoughtLevel !== undefined &&
		(session.advertisedThoughtLevels === undefined ||
			session.advertisedThoughtLevels.length === 0 ||
			session.advertisedThoughtLevels.includes(target.thoughtLevel))
			? target.thoughtLevel
			: undefined;

	if (desiredThought !== undefined && session.activeThoughtLevel !== desiredThought) {
		const res = await session.client.setConfigOption(session.conversationId, "thought_level", desiredThought, {
			timeoutMs: 15_000,
			signal,
		});
		const thoughtOpt = extractConfigOptionValues(res.configOptions, "thought_level");
		session.activeThoughtLevel = thoughtOpt.currentValue ?? desiredThought;
	}

	session.modelId = target.agyModelId;
	return target;
}

export function sendPrompt(session: AgySession, blocks: readonly AcpContentBlock[]): number {
	if (session.conversationId === undefined) {
		throw new Error("Antigravity ACP session has no conversationId.");
	}
	const seq = (session.promptSeq += 1);
	const promptPromise = session.client.prompt(session.conversationId, blocks);
	session.activePrompt = promptPromise;
	void promptPromise.then(
		(result) => {
			if (session.activePrompt === promptPromise) session.activePrompt = undefined;
			session.events.push({ type: "promptDone", promptSeq: seq, result });
		},
		(error: unknown) => {
			if (session.activePrompt === promptPromise) session.activePrompt = undefined;
			session.events.push({
				type: "promptError",
				promptSeq: seq,
				error: error instanceof Error ? error : new Error(String(error)),
			});
		},
	);
	return seq;
}

export async function cancelTurn(session: AgySession): Promise<boolean> {
	const active = session.activePrompt;
	if (active === undefined || session.conversationId === undefined || session.exited) return true;
	session.client.cancel(session.conversationId);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			active.then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), session.cancelTimeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function armHoldTimer(session: AgySession): void {
	clearHoldTimer(session);
	if (session.queue.size === 0 || session.holdLimitMs <= 0) return;
	const timer = setTimeout(() => {
		if (session.holdTimer !== timer) return;
		session.holdTimer = undefined;
		void detachParkedTools(session);
	}, session.holdLimitMs);
	timer.unref?.();
	session.holdTimer = timer;
}

export function clearHoldTimer(session: AgySession): void {
	if (session.holdTimer !== undefined) {
		clearTimeout(session.holdTimer);
		session.holdTimer = undefined;
	}
}

export async function detachParkedTools(
	session: AgySession,
	noticeText = "Tool execution exceeded the ACP bridge wait window; senpi is still running the tool and will deliver its result in a follow-up prompt.",
): Promise<void> {
	if (session.queue.size === 0 || session.exited) return;
	session.queue.beginDetach();
	await cancelTurn(session);
	session.queue.detachAll(noticeText);
}

export function rememberSessionBinding(session: AgySession): AgySessionBinding | undefined {
	if (session.conversationId === undefined) return undefined;
	const binding: AgySessionBinding = {
		conversationId: session.conversationId,
		syncedCount: session.syncedCount,
		prefixDigest: session.prefixDigest,
		modelId: session.modelId,
		...(session.lastAssistantDigest !== undefined ? { lastAssistantDigest: session.lastAssistantDigest } : {}),
		...(session.lastInputDigest !== undefined ? { lastInputDigest: session.lastInputDigest } : {}),
	};
	bindings.set(session.key, binding);
	return binding;
}

export function seedBinding(key: string, binding: SeedBindingInput): void {
	bindings.set(key, {
		conversationId: binding.conversationId,
		syncedCount: binding.syncedCount,
		prefixDigest: binding.prefixDigest,
		modelId: binding.modelId,
		...(binding.lastAssistantDigest !== undefined ? { lastAssistantDigest: binding.lastAssistantDigest } : {}),
		...(binding.lastInputDigest !== undefined ? { lastInputDigest: binding.lastInputDigest } : {}),
	});
}

export function closeSession(key: string, reason: string, options: { readonly keepConversation: boolean }): void {
	const session = sessions.get(key);
	if (session === undefined) {
		if (!options.keepConversation) bindings.delete(key);
		return;
	}
	sessions.delete(key);
	session.turnActive = false;
	clearHoldTimer(session);
	if (options.keepConversation) rememberSessionBinding(session);
	else bindings.delete(key);
	unregisterBridgeSession(session.token);
	session.queue.rejectAll(reason);
	terminate(session);
	if (!options.keepConversation) {
		if (session.exited) removeSessionWorkspace(session.workspace.dir);
		else session.process.once("close", () => removeSessionWorkspace(session.workspace.dir));
	}
}

export async function closeAllSessions(): Promise<void> {
	if (reaper !== undefined) clearInterval(reaper);
	reaper = undefined;
	for (const key of [...sessions.keys()]) closeSession(key, "session_shutdown", { keepConversation: true });
	const pending = [...terminating].filter((session) => !session.exited);
	if (pending.length === 0) {
		for (const session of [...terminating]) {
			clearKillTimer(session);
			terminating.delete(session);
		}
		return;
	}
	await Promise.all(
		pending.map(
			(session) =>
				new Promise<void>((resolve) => {
					if (session.exited) {
						clearKillTimer(session);
						terminating.delete(session);
						resolve();
						return;
					}
					const finish = () => {
						clearTimeout(deadline);
						clearKillTimer(session);
						terminating.delete(session);
						resolve();
					};
					const deadline = setTimeout(() => {
						if (!session.exited) sendSignal(session, "SIGKILL");
						clearKillTimer(session);
						terminating.delete(session);
						session.process.off("close", finish);
						resolve();
					}, 1_500);
					deadline.unref?.();
					session.process.once("close", finish);
				}),
		),
	);
}

function clearKillTimer(session: AgySession): void {
	if (session.killTimer !== undefined) {
		clearTimeout(session.killTimer);
		session.killTimer = undefined;
	}
}

export function reapIdleSessions(now = Date.now()): void {
	for (const session of sessions.values()) {
		if (!isEvictable(session) || now - session.lastUsedAt < IDLE_TIMEOUT_MS) continue;
		closeSession(session.key, "idle_timeout", { keepConversation: true });
	}
	evictToCapacity();
	if (lastWorkspaceRoot !== undefined) maybePruneWorkspaces(lastWorkspaceRoot, now);
}

function terminate(session: AgySession): void {
	if (session.exited || session.process.pid === undefined) return;
	terminating.add(session);
	sendSignal(session, "SIGTERM");
	const timer = setTimeout(() => {
		if (!session.exited) sendSignal(session, "SIGKILL");
	}, KILL_GRACE_MS);
	timer.unref();
	session.killTimer = timer;
}

function sendSignal(session: AgySession, signal: NodeJS.Signals): void {
	try {
		if (process.platform === "win32" || session.process.pid === undefined) {
			session.process.kill(signal);
			return;
		}
		process.kill(-session.process.pid, signal);
	} catch (error) {
		if (!isNoSuchProcess(error)) throw error;
	}
}

function isNoSuchProcess(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isEvictable(session: AgySession): boolean {
	return (
		!session.turnActive &&
		session.queue.size === 0 &&
		!session.queue.hasDetached() &&
		session.activePrompt === undefined
	);
}

function evictToCapacity(): void {
	while (sessions.size >= MAX_RESIDENT_SESSIONS) {
		const candidate = [...sessions.values()]
			.filter(isEvictable)
			.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
		if (candidate === undefined) return;
		closeSession(candidate.key, "lru_evicted", { keepConversation: true });
	}
}

function startReaper(): void {
	if (reaper !== undefined) return;
	reaper = setInterval(() => reapIdleSessions(), REAPER_INTERVAL_MS);
	reaper.unref();
}

function abortError(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
