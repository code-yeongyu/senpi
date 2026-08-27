import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { type EnsuredHost, ensureHost } from "../rpc/host-ensure.ts";
import { RpcClient, type RpcClientEvent } from "../rpc/rpc-client.ts";

export const INTERACTIVE_HOST_FALLBACK_WARNING = "Warning: shared interactive host unavailable; continuing locally";

export interface InteractiveHostWarning {
	readonly type: "interactive_host_fallback";
	readonly message: string;
	readonly cause: unknown;
}

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
	const client = new RpcClient({ socketPath: options.socket });
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
		const remoteSession = createRemoteSessionProxy(localRuntime.session, client, opened.state);
		return new RemoteInteractiveRuntime(localRuntime, remoteSession, client) as unknown as AgentSessionRuntime;
	} catch (cause) {
		await client.stop().catch(() => {});
		options.onWarning?.({
			type: "interactive_host_fallback",
			message: `${INTERACTIVE_HOST_FALLBACK_WARNING}: ${cause instanceof Error ? cause.message : String(cause)}`,
			cause,
		});
		return localRuntime;
	}
}

class RemoteInteractiveRuntime {
	readonly #local: AgentSessionRuntime;
	readonly #session: AgentSession;
	readonly #client: RpcClient;
	#rebindSession: (() => Promise<void>) | undefined;
	#beforeSessionInvalidate: (() => void) | undefined;

	constructor(local: AgentSessionRuntime, session: AgentSession, client: RpcClient) {
		this.#local = local;
		this.#session = session;
		this.#client = client;
	}

	get session(): AgentSession {
		return this.#session;
	}
	get services(): AgentSessionRuntime["services"] {
		return this.#local.services;
	}
	get cwd(): string {
		return this.#local.cwd;
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
	}
	setRebindSession(callback?: () => Promise<void>): void {
		this.#rebindSession = callback;
	}
	async dispose(): Promise<void> {
		await this.#client.closeSession();
		await this.#client.stop();
		await this.#local.dispose();
	}
	async newSession(): Promise<{ cancelled: boolean }> {
		this.#beforeSessionInvalidate?.();
		const result = await this.#client.newSession();
		if (!result.cancelled) await this.#rebindSession?.();
		return result;
	}
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		this.#beforeSessionInvalidate?.();
		const result = await this.#client.switchSession(sessionPath);
		if (!result.cancelled) await this.#rebindSession?.();
		return result;
	}
	async fork(entryId: string): Promise<{ cancelled: boolean; selectedText?: string }> {
		this.#beforeSessionInvalidate?.();
		const result = await this.#client.fork(entryId);
		if (!result.cancelled) await this.#rebindSession?.();
		return { cancelled: result.cancelled, selectedText: result.text };
	}
	async importFromJsonl(): Promise<{ cancelled: boolean }> {
		throw new Error("Session import is not available while connected to the shared host");
	}
}

function createRemoteSessionProxy(
	local: AgentSession,
	client: RpcClient,
	initialState: ReturnType<typeof stateFromRpc>,
): AgentSession {
	let state = initialState;
	let streamingAssistant: Extract<AgentSession["messages"][number], { role: "assistant" }> | undefined;
	const listeners = new Set<AgentSessionEventListener>();
	client.onEvent((wireEvent) => {
		if (wireEvent.type === "agent_settled") state = { ...state, isStreaming: false };
		if (wireEvent.type === "agent_start") state = { ...state, isStreaming: true };
		if (wireEvent.type === "model_changed") {
			state = { ...state, model: wireEvent.model, thinkingLevel: wireEvent.thinkingLevel };
		}
		if (wireEvent.type === "thinking_level_changed") state = { ...state, thinkingLevel: wireEvent.level };
		if (wireEvent.type === "message_start") {
			if (wireEvent.message.role === "assistant") streamingAssistant = structuredClone(wireEvent.message);
			local.agent.state.messages.push(structuredClone(wireEvent.message));
		}
		if (wireEvent.type === "message_end") {
			if (wireEvent.message.role === "assistant") streamingAssistant = structuredClone(wireEvent.message);
			const messages = local.agent.state.messages;
			const previous = messages.at(-1);
			if (previous?.role === wireEvent.message.role)
				messages[messages.length - 1] = structuredClone(wireEvent.message);
		}
		const event = hydrateMessageUpdate(wireEvent, streamingAssistant);
		for (const listener of listeners) listener(event);
	});
	const session = new Proxy(local, {
		get(target, property, receiver) {
			if (property === "prompt")
				return (message: string, options?: Parameters<AgentSession["prompt"]>[1]) =>
					client.prompt(message, options?.images);
			if (property === "abort") return () => client.abort();
			if (property === "steer")
				return (message: string, images?: Parameters<AgentSession["steer"]>[1]) => client.steer(message, images);
			if (property === "followUp")
				return (message: string, images?: Parameters<AgentSession["followUp"]>[1]) =>
					client.followUp(message, images);
			if (property === "waitForIdle") return () => client.waitForIdle();
			if (property === "getLastAssistantText") return () => target.getLastAssistantText();
			if (property === "setModel")
				return async (model: NonNullable<AgentSession["model"]>) => {
					await client.setModel(model.provider, model.id);
				};
			if (property === "cycleModel") return () => client.cycleModel();
			if (property === "setThinkingLevel")
				return (level: AgentSession["thinkingLevel"]) => void client.setThinkingLevel(level);
			if (property === "cycleThinkingLevel")
				return () => client.cycleThinkingLevel().then((result) => result?.level);
			if (property === "getAvailableThinkingLevels") return () => client.getAvailableThinkingLevels();
			if (property === "setSteeringMode")
				return (mode: AgentSession["steeringMode"]) => void client.setSteeringMode(mode);
			if (property === "setFollowUpMode")
				return (mode: AgentSession["followUpMode"]) => void client.setFollowUpMode(mode);
			if (property === "compact") return (instructions?: string) => client.compact(instructions);
			if (property === "setAutoCompactionEnabled")
				return (enabled: boolean) => void client.setAutoCompaction(enabled);
			if (property === "executeBash") return (command: string) => client.bash(command);
			if (property === "abortBash") return () => void client.abortBash();
			if (property === "getSessionStats") return () => client.getSessionStats();
			if (property === "exportToHtml")
				return (outputPath?: string) => client.exportHtml(outputPath).then((result) => result.path);
			if (property === "setSessionName") return (name: string) => void client.setSessionName(name);
			if (property === "getUserMessagesForForking") return () => client.getForkMessages();
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
			if (property === "sessionFile") return state.sessionFile;
			if (property === "sessionId") return state.sessionId;
			if (property === "messages") return target.messages;
			if (property === "model") return state.model ?? target.model;
			if (property === "thinkingLevel") return state.thinkingLevel;
			return Reflect.get(target, property, receiver);
		},
	});
	return session;
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
	sessionFile?: string;
	sessionId: string;
}) {
	return state;
}

export function isInteractiveHostEvent(event: RpcClientEvent): event is Extract<RpcClientEvent, { type: string }> {
	return typeof event === "object" && event !== null && "type" in event;
}
