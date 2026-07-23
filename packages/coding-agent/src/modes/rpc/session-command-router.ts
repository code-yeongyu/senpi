import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_OPEN_FAILED,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_UNKNOWN_SESSION,
} from "./rpc-types.ts";
import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionLaunchProfile, RpcSessionRegistry } from "./session-registry.ts";
import { RpcSessionRegistryError } from "./session-registry.ts";

const controls = new Set(["get_protocol_info", "open_session", "close_session", "list_sessions"]);

function error(id: string | undefined, command: string, code: string): RpcResponse {
	return { id, type: "response", command, success: false, error: code };
}

/** Routes control messages and enforces a routing handle for every session command. */
export class SessionCommandRouter {
	private readonly bindings = new Map<string, RpcSessionBinding>();
	private readonly registry: RpcSessionRegistry;
	private readonly writer: SessionEventWriter;
	private readonly defaults: Pick<
		RpcSessionLaunchProfile,
		"cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel"
	>;

	constructor(
		registry: RpcSessionRegistry,
		writer: SessionEventWriter,
		defaults: Pick<RpcSessionLaunchProfile, "cwd" | "permissionPreset" | "creationModel" | "initialThinkingLevel">,
	) {
		this.registry = registry;
		this.writer = writer;
		this.defaults = defaults;
	}

	async handle(command: RpcCommand): Promise<RpcResponse | undefined> {
		if (command.type === "get_protocol_info") {
			return {
				id: command.id,
				type: "response",
				command: "get_protocol_info",
				success: true,
				data: { protocolVersion: 1, capabilities: ["multi_session"], mode: "multi" },
			};
		}
		if (command.type === "list_sessions")
			return {
				id: command.id,
				type: "response",
				command: "list_sessions",
				success: true,
				data: { sessions: this.registry.list() },
			};
		if (command.type === "open_session") return this.open(command);
		if (command.type === "close_session") return this.close(command);
		if (controls.has(command.type)) return undefined;
		if (!command.sessionId) return error(command.id, command.type, RPC_ERROR_MISSING_SESSION_ID);
		try {
			this.registry.getForCommand(command.sessionId, command.type);
			await this.bindings.get(command.sessionId)?.handle(command);
			return undefined;
		} catch (cause) {
			return error(command.id, command.type, this.code(cause));
		}
	}

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.bindings.entries()].map(async ([sessionId, binding]) => {
				await binding.dispose();
				try {
					await this.registry.close(sessionId);
				} catch {
					/* already closed */
				}
			}),
		);
		this.bindings.clear();
	}

	private async open(command: Extract<RpcCommand, { type: "open_session" }>): Promise<RpcResponse | undefined> {
		try {
			const opened = await this.registry.openSession({
				cwd: command.cwd ?? this.defaults.cwd,
				sessionPath: command.sessionPath,
				permissionPreset: command.permissionPreset ?? this.defaults.permissionPreset,
				creationModel:
					command.provider && command.modelId
						? { provider: command.provider, modelId: command.modelId }
						: this.defaults.creationModel,
				initialThinkingLevel: command.thinkingLevel ?? this.defaults.initialThinkingLevel,
			});
			const entry = this.registry.getForCommand(opened.sessionId, "open_session");
			this.bindings.set(
				opened.sessionId,
				await createRpcSessionBinding(
					opened.sessionId,
					entry,
					this.writer,
					() => void this.close({ type: "close_session", sessionId: opened.sessionId }),
				),
			);
			const state = entry.runtime!.session;
			this.writer.enqueue(opened.sessionId, {
				id: command.id,
				type: "response",
				command: "open_session",
				success: true,
				data: {
					sessionId: opened.sessionId,
					state: {
						model: state.model,
						thinkingLevel: state.thinkingLevel,
						isStreaming: state.isStreaming,
						isCompacting: state.isCompacting,
						steeringMode: state.steeringMode,
						followUpMode: state.followUpMode,
						sessionFile: state.sessionFile,
						sessionId: state.sessionId,
						sessionName: state.sessionName,
						autoCompactionEnabled: state.autoCompactionEnabled,
						messageCount: state.messages.length,
						pendingMessageCount: state.pendingMessageCount,
					},
				},
			});
			return undefined;
		} catch (cause) {
			return error(command.id, "open_session", this.code(cause));
		}
	}

	private async close(command: Extract<RpcCommand, { type: "close_session" }>): Promise<RpcResponse | undefined> {
		try {
			await this.bindings.get(command.sessionId)?.dispose();
			this.bindings.delete(command.sessionId);
			await this.registry.close(command.sessionId);
			this.writer.closeSession(command.sessionId, {
				id: command.id,
				type: "response",
				command: "close_session",
				success: true,
				data: {},
			});
			return undefined;
		} catch (cause) {
			return error(command.id, "close_session", this.code(cause));
		}
	}

	private code(cause: unknown): string {
		if (cause instanceof RpcSessionRegistryError) return cause.code;
		if (cause instanceof Error && [RPC_ERROR_UNKNOWN_SESSION, RPC_ERROR_SESSION_CLOSING].includes(cause.message)) {
			return cause.message;
		}
		return cause instanceof Error && cause.message
			? `${RPC_ERROR_OPEN_FAILED}: ${cause.message}`
			: RPC_ERROR_UNKNOWN_SESSION;
	}
}
