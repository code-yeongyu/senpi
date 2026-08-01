import { type AgentToolResult, type ExtensionContext, sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import { appendSchemaHint } from "../bridges/schema-hint.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { handleCompletionToolCall } from "../completion/tool-bridge.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import { boundToolCallArgs, capCodePoints, MAX_ENRICHED_TOOL_CALLS, toolCallResultPreview } from "./call-capture.ts";
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

type ToolCallEnrichment = {
	readonly callId: string;
	readonly args: unknown;
	readonly startedAt: number;
	readonly argsTruncated?: true;
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
		if (message.toolName === "eval") {
			const error = "recursive eval is not allowed";
			this.#state.toolCalls.push({ name: message.toolName, ok: false, error });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: error },
			});
			return;
		}
		if (isReservedToolName(message.toolName)) {
			await this.#deliverToolReply(message, async () => ({
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
			}));
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
			this.#state.toolCalls.push(
				result.ok
					? { name: message.toolName, ok: true }
					: { name: message.toolName, ok: false, error: result.error },
			);
			this.#resultBuilder.emitUpdate(false);
			return;
		}
		const capturedArgs = boundToolCallArgs(message.args);
		const startedAt = Date.now();
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
			{
				callId: message.callId,
				args: capturedArgs.args,
				startedAt,
				...(capturedArgs.truncated ? { argsTruncated: true } : {}),
			},
		);
	}

	async #deliverToolReply(
		message: Extract<KernelToHostMessage, { type: "tool-call" }>,
		resolve: () => Promise<ResolvedToolReply>,
		enrich?: ToolCallEnrichment,
	): Promise<void> {
		try {
			const reply = await resolve();
			if (!this.#state.active) return;
			this.#pushToolCall(message.toolName, reply.toolCallOk, enrich, reply.resultPreview, reply.errorText);
			this.#kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value: reply.value });
		} catch (error) {
			if (!this.#state.active) return;
			const text = appendSchemaHint(
				error instanceof Error ? error.message : String(error),
				message.toolName,
				this.#toolParameters(message.toolName),
			);
			this.#pushToolCall(message.toolName, false, enrich, undefined, text);
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: text },
			});
		}
		this.#resultBuilder.emitUpdate(false);
	}

	#pushToolCall(
		name: string,
		ok: boolean,
		enrich: ToolCallEnrichment | undefined,
		resultPreview: string | undefined,
		error: string | undefined,
	): void {
		const summary = { name, ok, ...(error === undefined ? {} : { error }) };
		const enrichedCount = this.#state.toolCalls.filter((toolCall) => toolCall.callId !== undefined).length;
		if (enrich === undefined || enrichedCount >= MAX_ENRICHED_TOOL_CALLS) {
			this.#state.toolCalls.push(summary);
			return;
		}
		this.#state.toolCalls.push({
			...summary,
			callId: enrich.callId,
			args: enrich.args,
			durationMs: Date.now() - enrich.startedAt,
			...(enrich.argsTruncated === true ? { argsTruncated: true } : {}),
			...(resultPreview === undefined ? {} : { resultPreview }),
		});
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
