import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL } from "../bridge/reserved.ts";
import { type AgentExecuteTool, runEvalAgent } from "../bridges/agent-bridge.ts";
import { runEvalOutput } from "../bridges/output-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { handleCompletionToolCall } from "../completion/tool-bridge.ts";
import type { ResolvedCodemodeSettings } from "../config/settings.ts";
import {
	type EvalImageResizer,
	EvalOutputCollector,
	type EvalOutputResult,
	marshalToolResult,
	toolResultIsError,
} from "./image.ts";
import { upsertStatusEvent } from "./status-events.ts";
import type { EvalKernel, EvalStatusEvent, EvalToolDetails, EvalToolInput } from "./types.ts";

type ResolvedToolReply = { readonly value: unknown; readonly toolCallOk: boolean };

export interface CellState {
	readonly input: EvalToolInput;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: EvalToolDetails["toolCalls"] extends readonly (infer Item)[] ? Item[] : never;
	readonly pendingBridgeCalls: Promise<void>[];
	readonly statusEvents: EvalStatusEvent[];
	active: boolean;
	output: string;
	phase: string | undefined;
	durationMs: number;
	status: "pending" | "running" | "complete" | "error";
}

export interface CellBridgeRuntime {
	readonly executeTool: AgentExecuteTool;
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
	readonly #output: EvalOutputCollector;

	constructor(kernel: EvalKernel, state: CellState, runtime: CellBridgeRuntime) {
		this.#kernel = kernel;
		this.#state = state;
		this.#runtime = runtime;
		const settings = runtime.settings.outputSink;
		this.#output = new EvalOutputCollector({
			headBytes: settings.headBytes,
			maxColumns: settings.maxColumns,
			model: runtime.ctx.model,
			...(runtime.artifactPath === undefined ? {} : { artifactPath: runtime.artifactPath }),
			...(runtime.imageResizer === undefined ? {} : { imageResizer: runtime.imageResizer }),
			onChunk: (_aggregate, cell) => {
				state.output = cell;
				this.#emitUpdate(false);
			},
		});
		state.status = "running";
		this.#emitUpdate(false);
	}

	async handle(message: KernelToHostMessage): Promise<void> {
		if (!this.#state.active) return;
		switch (message.type) {
			case "text":
				this.#output.push(message.data);
				return;
			case "phase":
				this.#state.phase = message.title;
				this.#emitUpdate(false);
				return;
			case "status":
				this.#recordStatus(message.event);
				return;
			case "log":
				this.#output.push(`${message.message}\n`);
				return;
			case "display":
				this.#output.display(message);
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
		this.#state.durationMs = result.durationMs;
		if (result.ok) {
			if (result.valueRepr) this.#output.push(`${result.valueRepr}\n`);
			this.#state.status = "complete";
		} else {
			this.#output.push(`${result.error.message}\n`);
			this.#state.status = "error";
		}
		return await this.#finish(!result.ok);
	}

	async finalizeCancellation(error: Error): Promise<AgentToolResult<EvalToolDetails>> {
		this.#output.push(`${error.message}\n`);
		this.#state.status = "error";
		return await this.#finish(true);
	}

	async flushOutput(): Promise<void> {
		await this.#output.flush();
	}

	async #finish(isError: boolean): Promise<AgentToolResult<EvalToolDetails>> {
		const output = await this.#output.finish();
		this.#state.output = output.output;
		const details = this.#details(output, isError);
		this.#emitUpdate(isError);
		const text =
			output.output ||
			(output.images.length > 0
				? `(displayed ${output.images.length} image${output.images.length === 1 ? "" : "s"}; no text output)`
				: "(no output)");
		return { content: [{ type: "text", text }, ...output.images], details };
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
		if (message.toolName === RESERVED_AGENT_TOOL) {
			await this.#deliverToolReply(message, async () => ({
				value: await runEvalAgent(message.args, {
					callId: message.callId,
					taskToolName: this.#runtime.settings.taskTools.task,
					executeTool: this.#runtime.executeTool,
					signal: this.#state.signal,
					emitStatus: (event) => this.#recordStatus(event),
				}),
				toolCallOk: true,
			}));
			return;
		}
		if (message.toolName === RESERVED_OUTPUT_TOOL) {
			await this.#deliverToolReply(message, async () => ({
				value: await runEvalOutput(message.args, {
					taskOutputToolName: this.#runtime.settings.taskTools.output,
					executeTool: this.#runtime.executeTool,
					signal: this.#state.signal,
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
			this.#emitUpdate(false);
			return;
		}
		await this.#deliverToolReply(message, async () => {
			const result = await this.#runtime.executeTool(message.toolName, message.args, { signal: this.#state.signal });
			return { value: marshalToolResult(result), toolCallOk: !toolResultIsError(result) };
		});
	}

	async #deliverToolReply(
		message: Extract<KernelToHostMessage, { type: "tool-call" }>,
		resolve: () => Promise<ResolvedToolReply>,
	): Promise<void> {
		try {
			const reply = await resolve();
			if (!this.#state.active) return;
			this.#state.toolCalls.push({ name: message.toolName, ok: reply.toolCallOk });
			this.#kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: true, value: reply.value });
		} catch (error) {
			if (!this.#state.active) return;
			const text = error instanceof Error ? error.message : String(error);
			this.#state.toolCalls.push({ name: message.toolName, ok: false, error: text });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: text },
			});
		}
		this.#emitUpdate(false);
	}

	#recordStatus(event: EvalStatusEvent): void {
		if (!this.#runtime.settings.statusEvents) return;
		upsertStatusEvent(this.#state.statusEvents, event);
		this.#emitUpdate(false);
	}

	#details(output: EvalOutputResult | undefined, isError: boolean): EvalToolDetails {
		const statusEvents = this.#state.statusEvents.length > 0 ? [...this.#state.statusEvents] : undefined;
		return {
			language: this.#state.input.language,
			languages: [this.#state.input.language],
			...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
			durationMs: this.#state.durationMs,
			toolCalls: [...this.#state.toolCalls],
			truncated: output?.truncated ?? false,
			...(isError ? { isError: true } : {}),
			...(this.#state.phase === undefined ? {} : { phase: this.#state.phase }),
			cells: [
				{
					index: 0,
					...(this.#state.input.title === undefined ? {} : { title: this.#state.input.title }),
					code: this.#state.input.code,
					language: this.#state.input.language,
					output: this.#state.output,
					status: this.#state.status,
					durationMs: this.#state.durationMs,
					...(statusEvents === undefined ? {} : { statusEvents }),
					...(output?.hasMarkdown ? { hasMarkdown: true } : {}),
				},
			],
			...(statusEvents === undefined ? {} : { statusEvents }),
			...(output === undefined || output.jsonOutputs.length === 0 ? {} : { jsonOutputs: output.jsonOutputs }),
			...(output?.notice === undefined ? {} : { notice: output.notice }),
			...(output?.meta === undefined ? {} : { meta: output.meta }),
		};
	}

	#emitUpdate(isError: boolean): void {
		if (!this.#state.active) return;
		this.#state.onUpdate?.({
			content: [{ type: "text", text: this.#output.aggregateText() }],
			details: this.#details(undefined, isError),
		});
	}
}
