/**
 * Cursor exec-channel → local tool bridge.
 *
 * Cursor's agent protocol executes tools server-drivenly: mid-stream, the
 * server sends exec frames and blocks until the client answers in band. The
 * `cursor-agent` API dispatches those frames onto this bridge, which maps
 * each frame's args onto the session's real tools (`read`, `bash`, `edit`,
 * `write`, `grep`, `find`, `ls`, plus MCP/extension tools by name) and runs
 * them through the same wrapped `AgentTool.execute` path model-issued calls
 * use — so approvals, sandboxing, truncation, and rendering behavior stay
 * identical.
 *
 * The arg translations here MUST mirror the display blocks the API
 * synthesizes (`synthesizeCursorExecToolCall` call sites): the transcript
 * shows one operation, so a different one must not run.
 */

import type { AgentEvent, AgentTool, AgentToolCall } from "@earendil-works/pi-agent-core";
import {
	type CursorExecHandlers,
	composeCursorShellCommand,
	cursorPiLimit,
	cursorPiLsPath,
	cursorPiReadArgs,
	cursorPiTimeout,
	omitUndefinedCursorArgs,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type { ToolCallEvent, ToolCallEventResult } from "./extensions/types.ts";

export interface CursorExecBridgeOptions {
	/**
	 * Resolve an executable tool by name. Backed by the session's full tool
	 * registry (builtin + extension tools), not only the active set: Cursor
	 * drives its native tools (read/bash/grep/ls/write) over the exec channel
	 * regardless of which tools the request advertised.
	 */
	getTool: (name: string) => AgentTool | undefined;
	/**
	 * Surface tool lifecycle events to the host UI. Bridge-run tools bypass
	 * the agent loop's executor, so without these the live tool card for a
	 * synthesized call never resolves.
	 */
	emitEvent: (event: AgentEvent, runSignal: AbortSignal) => Promise<void>;
	/** Run the session's vetoable extension preflight before tool execution. */
	preflightToolCall?: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>;
	/** Abort signal for in-flight bridge executions (the active run's signal). */
	getAbortSignal: () => AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: true,
		timestamp: Date.now(),
	};
}

function emptyResult(toolCallId: string, toolName: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "" }],
		isError: false,
		timestamp: Date.now(),
	};
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): Promise<ToolResultMessage> {
	const runSignal = options.getAbortSignal();
	if (!runSignal) {
		return errorResult(toolCallId, toolName, "Tool execution has no active run");
	}

	const tool = options.getTool(toolName);
	if (!tool) {
		return errorResult(toolCallId, toolName, `Tool "${toolName}" is not available in this session`);
	}

	// Exec-frame translators write forms like `path: args.path || undefined`;
	// a present `undefined` fails schema validation on optional fields even
	// though omitting the key is valid.
	const cleanArgs = omitUndefinedCursorArgs(args);
	const toolCall: AgentToolCall = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: cleanArgs,
	};

	let params: unknown;
	try {
		params = validateToolArguments(tool, toolCall);
		if (tool.prepareArguments) {
			params = tool.prepareArguments(params);
		}
	} catch (error) {
		return errorResult(toolCallId, toolName, error instanceof Error ? error.message : String(error));
	}

	await options.emitEvent({ type: "tool_execution_start", toolCallId, toolName, args: cleanArgs }, runSignal);
	let toolResult: ToolResultMessage;
	let endEvent: AgentEvent;
	try {
		if (!isRecord(params)) {
			throw new Error(`Tool "${toolName}" prepared non-object arguments`);
		}
		const preflight = await options.preflightToolCall?.({
			type: "tool_call",
			toolCallId,
			toolName,
			input: params,
		});
		if (preflight?.block) {
			const message = preflight.reason || "Tool execution was blocked";
			toolResult = errorResult(toolCallId, toolName, message);
			endEvent = {
				type: "tool_execution_end",
				toolCallId,
				toolName,
				result: { content: [{ type: "text", text: message }], details: undefined },
				isError: true,
			};
		} else {
			const result = await tool.execute(toolCallId, params, runSignal, undefined);
			toolResult = {
				role: "toolResult",
				toolCallId,
				toolName,
				content: result.content ?? [],
				details: result.details,
				usage: result.usage,
				isError: false,
				timestamp: Date.now(),
			};
			endEvent = { type: "tool_execution_end", toolCallId, toolName, result, isError: false };
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		toolResult = errorResult(toolCallId, toolName, message);
		endEvent = {
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [{ type: "text", text: message }], details: undefined },
			isError: true,
		};
	}
	await options.emitEvent(endEvent, runSignal);
	return toolResult;
}

/**
 * Build the exec handlers passed to the `cursor-agent` API through the agent
 * loop config. Handlers return bare `ToolResultMessage`s; the API derives the
 * wire protobuf answer from them and pairs the transcript result.
 *
 * Deliberately absent handlers (the API answers with a typed refusal):
 * - `delete`: senpi has no delete tool and the bridge must not mutate the
 *   filesystem outside the tool/approval path.
 * - `diagnostics`: no LSP tool in this fork.
 * - `mcpApprovalPreflight`: approval decisions cannot be resolved without an
 *   interactive prompt, so smart-mode probes are conservatively refused.
 */
export function createCursorExecBridge(options: CursorExecBridgeOptions): CursorExecHandlers {
	return {
		read: async (args) =>
			executeTool(options, "read", args.toolCallId, {
				path: args.path,
				offset: args.offset,
				limit: args.limit,
			}),

		ls: async (args) => executeTool(options, "ls", args.toolCallId, { path: cursorPiLsPath(args.path) }),

		grep: async (args) =>
			executeTool(options, "grep", args.toolCallId, {
				pattern: args.pattern,
				path: args.path || undefined,
				glob: args.glob || undefined,
				ignoreCase: args.caseInsensitive === true ? true : undefined,
			}),

		write: async (args) =>
			executeTool(options, "write", args.toolCallId, {
				path: args.path,
				content: args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array()),
			}),

		shell: async (args) =>
			executeTool(options, "bash", args.toolCallId, {
				command: composeCursorShellCommand(args.command, args.workingDirectory || undefined),
				timeout: args.timeout && args.timeout > 0 ? args.timeout : undefined,
			}),

		mcp: async (call) => {
			const toolName = call.toolName || call.name;
			const tool = options.getTool(toolName);
			if (!tool) {
				return errorResult(call.toolCallId, toolName, `Tool "${toolName}" is not registered in this session`);
			}
			return executeTool(options, toolName, call.toolCallId, call.args);
		},

		piRead: async (call) => {
			const readArgs = cursorPiReadArgs(call.args.path, call.args.offset, call.args.limit);
			// A present `limit: 0` reads zero lines; answer with empty output
			// without running the tool rather than degrading into a full read.
			if (readArgs === null) return emptyResult(call.toolCallId, "read");
			return executeTool(options, "read", call.toolCallId, readArgs);
		},

		piBash: async (call) =>
			executeTool(options, "bash", call.toolCallId, {
				command: call.args.command,
				timeout: cursorPiTimeout(call.args.timeout),
			}),

		piEdit: async (call) =>
			executeTool(options, "edit", call.toolCallId, {
				path: call.args.path,
				edits: call.args.edits.map((edit) => ({ oldText: edit.oldText, newText: edit.newText })),
			}),

		piWrite: async (call) =>
			executeTool(options, "write", call.toolCallId, {
				path: call.args.path,
				content: call.args.content,
			}),

		piGrep: async (call) =>
			executeTool(options, "grep", call.toolCallId, {
				pattern: call.args.pattern,
				path: call.args.path || undefined,
				glob: call.args.glob || undefined,
				ignoreCase: call.args.ignoreCase === true ? true : undefined,
				literal: call.args.literal === true ? true : undefined,
				context: call.args.context,
				limit: cursorPiLimit(call.args.limit),
			}),

		piFind: async (call) =>
			executeTool(options, "find", call.toolCallId, {
				pattern: call.args.pattern,
				path: call.args.path || undefined,
				limit: cursorPiLimit(call.args.limit),
			}),

		piLs: async (call) =>
			executeTool(options, "ls", call.toolCallId, {
				path: cursorPiLsPath(call.args.path),
				limit: cursorPiLimit(call.args.limit),
			}),
	};
}
