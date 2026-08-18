/**
 * Cursor exec-channel handler contracts.
 *
 * The Cursor agent protocol is server-driven: mid-turn, the server sends
 * `ExecServerMessage` frames asking the CLIENT to run a tool and blocks until
 * the reply arrives on the same stream. The host (coding-agent) supplies
 * these handlers; the `cursor-agent` API dispatches frames onto them, sends
 * their protobuf answers back on the wire, synthesizes already-resolved
 * `toolCall` blocks into the assistant message, and pairs each with a
 * `ToolResultMessage` delivered through {@link CursorToolResultHandler}.
 *
 * Everything here is type-only over the generated protobuf shapes, so it is
 * safe to import from browser-reachable modules.
 */

import type { StreamOptions, ToolResultMessage } from "../../types.ts";
import type {
	DeleteArgs,
	DeleteResult,
	DiagnosticsArgs,
	DiagnosticsResult,
	GrepArgs,
	GrepResult,
	LsArgs,
	LsResult,
	McpResult,
	PiBashExecArgs,
	PiBashExecResult,
	PiEditExecArgs,
	PiEditExecResult,
	PiFindExecArgs,
	PiFindExecResult,
	PiGrepExecArgs,
	PiGrepExecResult,
	PiLsExecArgs,
	PiLsExecResult,
	PiReadExecArgs,
	PiReadExecResult,
	PiWriteExecArgs,
	PiWriteExecResult,
	ReadArgs,
	ReadResult,
	ShellArgs,
	ShellResult,
	WriteArgs,
	WriteResult,
} from "./gen/agent_pb.ts";

/**
 * The three return forms an exec handler may use: a wire result with an
 * optional transcript pairing, a bare wire result, or a bare
 * `ToolResultMessage` from which the wire result is derived.
 */
export type CursorExecHandlerResult<T> = { result: T; toolResult?: ToolResultMessage } | T | ToolResultMessage;

/**
 * Optional rewrite of a Cursor exec-channel tool result.
 * May return a Promise. Returning `undefined` keeps the original result.
 */
export type CursorToolResultHandler = (
	result: ToolResultMessage,
) => ToolResultMessage | undefined | Promise<ToolResultMessage | undefined>;

/**
 * Identifies the synthesized assistant block a Cursor exec call was filed
 * under, so paths that produce no handler `toolResult` can still pair one.
 */
export interface CursorExecPairing {
	toolCallId: string;
	toolName: string;
}

export interface CursorMcpCall {
	name: string;
	providerIdentifier: string;
	toolName: string;
	toolCallId: string;
	args: Record<string, unknown>;
	rawArgs: Record<string, Uint8Array>;
	/**
	 * The frame asks only whether this call would be permitted — it must not
	 * run. The server sends it to resolve a smart-mode approval decision ahead
	 * of the real invocation; executing here would fire a side-effecting tool
	 * the user has not yet been asked about (and fire it twice once the real
	 * call arrives).
	 */
	approvalOnly?: boolean;
}

export interface CursorShellStreamCallbacks {
	onStdout(data: string): void;
	onStderr(data: string): void;
}

/**
 * A modern Pi exec frame plus the call id the dispatcher minted for it.
 *
 * Unlike the legacy exec args (`ReadArgs`, `ShellArgs`, ...), the Pi frames
 * carry no `tool_call_id` field: the id rides the streamed `ToolCall`
 * envelope instead. The exec channel has no access to that envelope, so the
 * dispatcher mints an id and hands it to the handler, keeping the synthesized
 * transcript block and its paired `toolResult` on the same key.
 */
export interface CursorPiCall<TArgs> {
	args: TArgs;
	toolCallId: string;
}

export interface CursorExecHandlers {
	read?: (args: ReadArgs) => Promise<CursorExecHandlerResult<ReadResult>>;
	ls?: (args: LsArgs) => Promise<CursorExecHandlerResult<LsResult>>;
	grep?: (args: GrepArgs) => Promise<CursorExecHandlerResult<GrepResult>>;
	write?: (args: WriteArgs) => Promise<CursorExecHandlerResult<WriteResult>>;
	delete?: (args: DeleteArgs) => Promise<CursorExecHandlerResult<DeleteResult>>;
	shell?: (args: ShellArgs) => Promise<CursorExecHandlerResult<ShellResult>>;
	shellStream?: (
		args: ShellArgs,
		callbacks: CursorShellStreamCallbacks,
	) => Promise<CursorExecHandlerResult<ShellResult>>;
	diagnostics?: (args: DiagnosticsArgs) => Promise<CursorExecHandlerResult<DiagnosticsResult>>;
	mcp?: (call: CursorMcpCall) => Promise<CursorExecHandlerResult<McpResult>>;
	/**
	 * Answers "would this MCP call be permitted", without running it.
	 *
	 * `true` only when the host's policy resolves to a definite allow. A
	 * pending prompt is `false`: it can only be answered interactively at
	 * execution time. When no handler is registered the provider refuses,
	 * since it cannot decide.
	 */
	mcpApprovalPreflight?: (call: CursorMcpCall) => Promise<boolean>;
	/**
	 * Modern Cursor CLI Pi tool frames (`ExecServerMessage` 45-51). They are a
	 * distinct frame family from the legacy `readArgs`/`shellArgs`/... set:
	 * different args, different result oneofs, and no `tool_call_id`.
	 */
	piRead?: (call: CursorPiCall<PiReadExecArgs>) => Promise<CursorExecHandlerResult<PiReadExecResult>>;
	piBash?: (call: CursorPiCall<PiBashExecArgs>) => Promise<CursorExecHandlerResult<PiBashExecResult>>;
	piEdit?: (call: CursorPiCall<PiEditExecArgs>) => Promise<CursorExecHandlerResult<PiEditExecResult>>;
	piWrite?: (call: CursorPiCall<PiWriteExecArgs>) => Promise<CursorExecHandlerResult<PiWriteExecResult>>;
	piGrep?: (call: CursorPiCall<PiGrepExecArgs>) => Promise<CursorExecHandlerResult<PiGrepExecResult>>;
	piFind?: (call: CursorPiCall<PiFindExecArgs>) => Promise<CursorExecHandlerResult<PiFindExecResult>>;
	piLs?: (call: CursorPiCall<PiLsExecArgs>) => Promise<CursorExecHandlerResult<PiLsExecResult>>;
	onToolResult?: CursorToolResultHandler;
}

/** Stream options accepted by the `cursor-agent` API. */
export interface CursorAgentOptions extends StreamOptions {
	/** Optional server-side system prompt override (RunRequest.customSystemPrompt). */
	customSystemPrompt?: string;
	/** Conversation id override; defaults to `sessionId`, else a random UUID per stream. */
	conversationId?: string;
	/** Cursor exec/MCP tool handlers supplied by the host. */
	execHandlers?: CursorExecHandlers;
	/** Receives every exec-channel tool result for transcript pairing. */
	onToolResult?: CursorToolResultHandler;
}
