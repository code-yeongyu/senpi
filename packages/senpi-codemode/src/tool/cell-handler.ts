import { type AgentToolResult, type ExtensionContext, sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { RESERVED_SCHEMA_TOOL } from "../bridge/reserved.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import { appendSchemaHint } from "../bridges/schema-hint.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { handleCompletionToolCall } from "../completion/tool-bridge.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import {
	boundToolCallArgs,
	capCodePoints,
	createToolCallMetric,
	MAX_CAPTURED_IDENTIFIER_CODE_POINTS,
	recordToolCall,
	type ToolCallCapture,
	toolCallResultPreview,
} from "./call-capture.ts";
import { CellResultBuilder, type CellState } from "./cell-runtime.ts";
import { type EvalImageResizer, marshalToolResult, toolResultIsError } from "./image.ts";
import { upsertStatusEvent } from "./status-events.ts";
import type { EvalKernel, EvalStatusEvent, EvalToolDetails } from "./types.ts";

export type { CellState } from "./cell-runtime.ts";

type ResolvedToolReply = {
	readonly value: unknown;
	readonly toolCallOk: boolean;
	readonly resultPreview?: string;
	readonly errorText?: string;
};

export interface CellBridgeRuntime {
	readonly executeTool: AgentExecuteTool;
	readonly listTools?: () => readonly EvalSchemaToolInfo[];
	readonly settings: ResolvedCodemodeSettings;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
	readonly artifactPath?: string;
	readonly imageResizer?: EvalImageResizer;
}

export class CellHandler {
	readonly #kernel: EvalKernel;
	readonly #state: CellState;
	readonly #runtime: CellBridgeRuntime;
	readonly #resultBuilder: CellResultBuilder;

	constructor(kernel: EvalKernel, state: CellState, runtime: CellBridgeRuntime) {
		this.#kernel = kernel;
		this.#state = state;
		this.#runtime = runtime;
		const settings = runtime.settings.outputSink;
		this.#resultBuilder = new CellResultBuilder({
			state,
			headBytes: settings.headBytes,
			maxColumns: settings.maxColumns,
			model: runtime.ctx.model,
			...(runtime.artifactPath === undefined ? {} : { artifactPath: runtime.artifactPath }),
			...(runtime.imageResizer === undefined ? {} : { imageResizer: runtime.imageResizer }),
		});
	}

	async handle(message: KernelToHostMessage): Promise<void> {
		if (!this.#state.active) return;
		switch (message.type) {
			case "text":
				this.#resultBuilder.push(message.data);
				return;
			case "phase":
				this.#resultBuilder.setPhase(message.title);
				return;
			case "status":
				this.#recordStatus(message.event);
				return;
			case "log":
				this.#resultBuilder.push(`${message.message}\n`);
				return;
			case "display":
				this.#resultBuilder.display(message);
				return;
			case "tool-call": {
				const pending = this.#handleToolCall(message);
				this.#state.pendingBridgeCalls.push(pending);
				await pending;
				return;
			}
			case "ready":
			case "init-failed":
			case "result":
			case "closed":
				return;
			default:
				throw new TypeError(`Unhandled kernel message: ${String(message)}`);
		}
	}

	async finalize(result: Extract<KernelToHostMessage, { type: "result" }>): Promise<AgentToolResult<EvalToolDetails>> {
		return await this.#resultBuilder.finalize(result);
	}

	async finalizeCancellation(error: Error): Promise<AgentToolResult<EvalToolDetails>> {
		return await this.#resultBuilder.finalizeCancellation(error);
	}

	async flushOutput(): Promise<void> {
		await this.#resultBuilder.flushOutput();
	}

	liveResult(): AgentToolResult<EvalToolDetails> {
		return this.#resultBuilder.liveResult();
	}

	async #handleToolCall(message: Extract<KernelToHostMessage, { type: "tool-call" }>): Promise<void> {
		const startedAt = Date.now();
		const metric = createToolCallMetric(message.toolName, startedAt);
		this.#state.toolCallMetrics.push(metric);
		const capturedArgs = boundToolCallArgs(message.args);
		const capture: ToolCallCapture = {
			callId: capCodePoints(message.callId, MAX_CAPTURED_IDENTIFIER_CODE_POINTS),
			args: capturedArgs.args,
			startedAt,
			metric,
			includeDetails: message.toolName !== RESERVED_SCHEMA_TOOL,
			...(capturedArgs.truncated ? { argsTruncated: true } : {}),
		};
		if (message.toolName === "eval") {
			const error = "recursive eval is not allowed";
			recordToolCall(this.#state.toolCalls, false, capture, undefined, error);
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: error },
			});
			return;
		}
		if (isReservedToolName(message.toolName)) {
			await this.#deliverToolReply(
				message,
				async () => ({
					value: await runReservedTool(message.toolName, {
						callId: message.callId,
						args: message.args,
						executeTool: this.#runtime.executeTool,
						taskToolName: this.#runtime.settings.taskTools.task,
						taskOutputToolName: this.#runtime.settings.taskTools.output,
						listTools: this.#runtime.listTools,
						signal: this.#state.signal,
						emitStatus: (event) => this.#recordStatus(event),
						marshalToolResult,
					}),
					toolCallOk: true,
				}),
				capture,
			);
			return;
		}
		if (message.toolName === "completion" && this.#runtime.complete) {
			const result = await handleCompletionToolCall({
				message,
				kernel: this.#kernel,
				complete: this.#runtime.complete,
				ctx: this.#runtime.ctx,
				isActive: () => this.#state.active,
			});
			if (!this.#state.active) return;
			recordToolCall(this.#state.toolCalls, result.ok, capture, undefined, result.ok ? undefined : result.error);
			this.#resultBuilder.emitUpdate(false);
			return;
		}
		await this.#deliverToolReply(
			message,
			async () => {
				const result = await this.#runtime.executeTool(message.toolName, message.args, {
					signal: this.#state.signal,
				});
				const toolCallOk = !toolResultIsError(result);
				if (toolCallOk) {
					const resultPreview = toolCallResultPreview(result);
					return {
						value: marshalToolResult(result),
						toolCallOk,
						...(resultPreview === undefined ? {} : { resultPreview }),
					};
				}
				let errorText: string | undefined;
				for (const part of result.content) {
					if (part.type !== "text") continue;
					errorText = capCodePoints(sanitizeTerminalLabel(part.text), 512);
					break;
				}
				return {
					value: marshalToolResult(result),
					toolCallOk,
					...(errorText === undefined ? {} : { errorText }),
				};
			},
			capture,
		);
	}

	async #deliverToolReply(
		message: Extract<KernelToHostMessage, { type: "tool-call" }>,
		resolve: () => Promise<ResolvedToolReply>,
		capture: ToolCallCapture,
	): Promise<void> {
		try {
			const reply = await resolve();
			if (!this.#state.active) return;
			recordToolCall(this.#state.toolCalls, reply.toolCallOk, capture, reply.resultPreview, reply.errorText);
			this.#kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value: reply.value });
		} catch (error) {
			if (!this.#state.active) return;
			const text = appendSchemaHint(
				error instanceof Error ? error.message : String(error),
				message.toolName,
				this.#toolParameters(message.toolName),
			);
			recordToolCall(this.#state.toolCalls, false, capture, undefined, text);
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: text },
			});
		}
		this.#resultBuilder.emitUpdate(false);
	}

	#toolParameters(toolName: string): unknown {
		return this.#runtime.listTools?.().find((tool) => tool.name === toolName)?.parameters;
	}

	#recordStatus(event: EvalStatusEvent): void {
		if (!this.#runtime.settings.statusEvents) return;
		upsertStatusEvent(this.#state.statusEvents, event);
		this.#resultBuilder.emitUpdate(false);
	}
}
