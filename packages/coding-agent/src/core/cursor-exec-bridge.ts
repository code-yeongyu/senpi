/**
 * Cursor exec-channel → local tool bridge.
 *
 * Cursor's agent protocol executes tools server-drivenly: mid-stream, the
 * server sends exec frames and blocks until the client answers in band. The
 * `cursor-agent` API dispatches those frames onto this bridge, which maps
 * each frame's args onto the session's real tools (`read`, `bash`, `edit`,
 * `write`, `grep`, `find`, `ls`, plus MCP/extension tools by name) and runs
 * each one as a one-call batch on the prepared pipeline model-issued calls
 * run on — so validation, approvals, sandboxing, truncation, rendering and
 * the execution witness stay identical (#5780).
 *
 * The arg translations here MUST mirror the display blocks the API
 * synthesizes (`synthesizeCursorExecToolCall` call sites): the transcript
 * shows one operation, so a different one must not run.
 */

import {
	type AgentEvent,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	type BatchStoreFactory,
	createPreparedToolHost,
	type ExecutionPipelineWitness,
	type ExecutionScope,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type CursorExecHandlers,
	composeCursorShellCommand,
	cursorPiLimit,
	cursorPiLsPath,
	cursorPiReadArgs,
	cursorPiTimeout,
	omitUndefinedCursorArgs,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ToolCallEvent, ToolCallEventResult } from "./extensions/types.ts";
import { carryPreflightFacts } from "./execution/preflight-carry.ts";

export interface CursorExecBridgeOptions {
	/**
	 * Resolve an executable tool by name. Backed by the session's full tool
	 * registry (builtin + extension tools), not only the active set: Cursor
	 * drives its native tools (read/bash/grep/ls/write) over the exec channel
	 * regardless of which tools the request advertised.
	 */
	getTool: (name: string) => AgentTool | undefined;
	/**
	 * Surface tool lifecycle events to the host UI. Bridge-run calls run
	 * mid-stream, outside the loop's own tool batch, so without these the live
	 * tool card for a synthesized call never resolves.
	 */
	emitEvent: (event: AgentEvent, runSignal: AbortSignal) => Promise<void>;
	/** Same tool_result hook the local tool loop emits; plan-touch trackers listen here. */
	emitToolResult?: (event: {
		toolName: string;
		toolCallId: string;
		args: unknown;
		result: AgentToolResult<unknown>;
		isError: boolean;
	}) => Promise<void>;
	/** Run the session's vetoable extension preflight before tool execution. */
	preflightToolCall?: (event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>;
	/** Abort signal for in-flight bridge executions (the active run's signal). */
	getAbortSignal: () => AbortSignal | undefined;
	/** The per-batch store the prepared pipeline runs each call on (the agent's `batchStoreFactory`). */
	openBatchStore: BatchStoreFactory;
	/** The session's execution scope, as the loop passes it to its own batches. */
	getExecutionScope: () => ExecutionScope;
	/** The agent's `onExecutionPipeline` sink: one receipt per call, like a model-issued call. */
	recordWitness?: (witness: ExecutionPipelineWitness) => Promise<void> | void;
}

const NO_ACTIVE_RUN = "Tool execution has no active run";

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

function mapCursorPiGrepArgs(args: Record<string, unknown>): Record<string, unknown> {
	const known = new Set(["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]);
	for (const key of Object.keys(args)) {
		if (!known.has(key)) console.debug(`[cursor-exec] ignoring unknown pi_grep flag: ${key}`);
	}
	return omitUndefinedCursorArgs({
		pattern: args.pattern,
		path: args.path,
		glob: args.glob,
		ignoreCase: args.ignoreCase,
		literal: args.literal,
		context: args.context,
		limit: args.limit,
	});
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

/** A frame's call as the message that issued it: Cursor's server issued it, so there is no model message to point at. */
function issuingMessage(toolCall: AgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-exec",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

/** The provider pairs the frame's result and the loop emits its message with the buffered results; the bridge must not. */
function isToolResultMessageEvent(event: AgentEvent): boolean {
	return (event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult";
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): Promise<ToolResultMessage> {
	const runSignal = options.getAbortSignal();
	if (!runSignal || runSignal.aborted) {
		return errorResult(toolCallId, toolName, NO_ACTIVE_RUN);
	}

	const tool = options.getTool(toolName);
	if (!tool) {
		return errorResult(toolCallId, toolName, `Tool "${toolName}" is not available in this session`);
	}

	const toolCall: AgentToolCall = {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		// Exec-frame translators write forms like `path: args.path || undefined`; a present `undefined` fails schema
		// validation on optional fields. The args are JSON (protobuf Value toJson / JSON.parse or pi-args scalars).
		arguments: omitUndefinedCursorArgs(args) as AgentToolCall["arguments"],
	};
	// Ownership is rechecked at execution itself, not only when preflight returns: on the prepared host the call still
	// awaits its digest, ledger steps and release after preflight, and a run that ends normally changes the agent's
	// signal without aborting it, so a finished run's late frame must not run its side effect inside the next run.
	const ownedTool: AgentTool = Object.create(tool, {
		execute: {
			value: (...call: Parameters<AgentTool["execute"]>) => {
				if (runSignal.aborted || options.getAbortSignal() !== runSignal) throw new Error(NO_ACTIVE_RUN);
				return tool.execute(...call);
			},
		},
	});
	// The same prepared host model-issued calls run on: validation, argument preparation, the session's tool_call
	// preflight and tool_result hook, lifecycle events and the witness receipt all come from it. The host resolves only
	// this call's tool: Cursor drives its native tools whether or not the request advertised them.
	const host = createPreparedToolHost(
		{
			// The bridge's preflight runs the session's tool_call chain on this object too (senpi#5795).
			afterToolFreeze: carryPreflightFacts,
			beforeToolCall: async ({ args: input }) => {
				const preflight = await options.preflightToolCall?.({
					type: "tool_call",
					toolCallId,
					toolName,
					// Validated by the executor's argument check (a non-object never reaches this hook) and JSON from the frame.
					input: input as Record<string, unknown>,
				});
				// The owning run may have ended while preflight waited; a replacement run must not inherit this call.
				if (runSignal.aborted || options.getAbortSignal() !== runSignal)
					return { block: true, reason: NO_ACTIVE_RUN };
				return preflight?.block
					? { block: true, reason: preflight.reason || "Tool execution was blocked" }
					: undefined;
			},
			afterToolCall: async ({ args: input, result, isError }) => {
				await options.emitToolResult?.({ toolName, toolCallId, args: input, result, isError });
				return undefined;
			},
			removedToolHints: {},
		},
		options.openBatchStore,
	);
	const { messages } = await host.execute(
		{ scope: options.getExecutionScope(), calls: [toolCall], mode: "sequential" },
		{
			signal: runSignal,
			emit: async (event) => {
				if (!isToolResultMessageEvent(event)) await options.emitEvent(event, runSignal);
			},
			...(options.recordWitness === undefined ? {} : { recordWitness: options.recordWitness }),
			local: {
				context: { systemPrompt: "", messages: [], tools: [ownedTool] },
				assistantMessage: issuingMessage(toolCall),
			},
		},
	);
	return messages[0] ?? errorResult(toolCallId, toolName, NO_ACTIVE_RUN);
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
			executeTool(
				options,
				"grep",
				call.toolCallId,
				mapCursorPiGrepArgs({
					...call.args,
					ignoreCase: call.args.ignoreCase === true ? true : undefined,
					literal: call.args.literal === true ? true : undefined,
					limit: cursorPiLimit(call.args.limit),
				}),
			),

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
