import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL } from "../bridge/reserved.ts";
import { type AgentExecuteTool, runEvalAgent } from "../bridges/agent-bridge.ts";
import { runEvalOutput } from "../bridges/output-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { handleCompletionToolCall } from "../completion/tool-bridge.ts";
import { type CodemodeSettings, defaultCodemodeSettings } from "../config/settings.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../host-sdk.ts";
import { upsertStatusEvent } from "./status-events.ts";
import type { EvalKernel, EvalStatusEvent, EvalToolDetails, EvalToolInput } from "./types.ts";

type ImageContent = { type: "image"; mimeType: string; data: string };
type ToolContent = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;
type RuntimeImagePart = { type: "image"; mimeType: string; data: string };
type ResolvedToolReply = { readonly value: unknown; readonly toolCallOk: boolean };
export interface CellState {
	readonly cellId: string;
	readonly language: EvalToolInput["language"];
	readonly title: string | undefined;
	readonly signal: AbortSignal;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: EvalToolDetails["toolCalls"] extends readonly (infer T)[] ? T[] : never;
	readonly images: ImageContent[];
	readonly pendingBridgeCalls: Promise<void>[];
	statusEvents?: EvalStatusEvent[];
	active: boolean;
	output: string;
	phase: string | undefined;
	durationMs: number;
}

export interface CellBridgeRuntime {
	readonly executeTool: AgentExecuteTool;
	readonly settings?: Pick<CodemodeSettings, "taskTools">;
	readonly complete?: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>;
	readonly ctx: ExtensionContext;
}

export class CellHandler {
	readonly #kernel: EvalKernel;
	readonly #state: CellState;
	readonly #runtime: CellBridgeRuntime;

	constructor(kernel: EvalKernel, state: CellState, runtime: CellBridgeRuntime) {
		this.#kernel = kernel;
		this.#state = state;
		this.#runtime = runtime;
	}

	async handle(message: KernelToHostMessage): Promise<void> {
		if (!this.#state.active) return;
		if (message.type === "text") {
			this.#state.output += message.data;
			this.#emitUpdate(false);
			return;
		}
		if (message.type === "phase") {
			this.#state.phase = message.title;
			this.#emitUpdate(false);
			return;
		}
		if (message.type === "log") {
			this.#state.output += `${message.message}\n`;
			this.#emitUpdate(false);
			return;
		}
		if (message.type === "display") {
			this.#state.images.push({ type: "image", mimeType: message.mimeType, data: message.dataBase64 });
			this.#state.output += `[display: ${message.mimeType}]\n`;
			this.#emitUpdate(false);
			return;
		}
		if (message.type === "tool-call") {
			const pending = this.#handleToolCall(message);
			this.#state.pendingBridgeCalls.push(pending);
			await pending;
		}
	}

	finalize(result: Extract<KernelToHostMessage, { type: "result" }>): AgentToolResult<EvalToolDetails> {
		this.#state.durationMs = result.durationMs;
		if (result.ok && result.valueRepr) this.#state.output += `${result.valueRepr}\n`;
		if (!result.ok) this.#state.output += `${result.error.message}\n`;
		const truncation = truncateTail(this.#state.output, {
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
		});
		const suffix = truncation.truncated
			? `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.outputBytes} of ${truncation.totalBytes} bytes).]`
			: "";
		return {
			content: [{ type: "text", text: `${truncation.content}${suffix}` }, ...this.#state.images],
			details: this.#details(truncation.truncated, !result.ok),
		};
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
			await this.#handleAgentToolCall(message);
			return;
		}
		if (message.toolName === RESERVED_OUTPUT_TOOL) {
			await this.#handleOutputToolCall(message);
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
			const result = await this.#runtime.executeTool(message.toolName, message.args, {
				signal: this.#state.signal,
			});
			return { value: marshalToolResult(result), toolCallOk: !toolResultIsError(result) };
		});
	}

	async #handleAgentToolCall(message: Extract<KernelToHostMessage, { type: "tool-call" }>): Promise<void> {
		await this.#deliverToolReply(message, async () => ({
			value: await runEvalAgent(message.args, {
				callId: message.callId,
				taskToolName: this.#runtime.settings?.taskTools?.task ?? defaultCodemodeSettings.taskTools.task,
				executeTool: this.#runtime.executeTool,
				signal: this.#state.signal,
				emitStatus: (event) => this.#recordStatus(event),
			}),
			toolCallOk: true,
		}));
	}

	async #handleOutputToolCall(message: Extract<KernelToHostMessage, { type: "tool-call" }>): Promise<void> {
		await this.#deliverToolReply(message, async () => ({
			value: await runEvalOutput(message.args, {
				taskOutputToolName: this.#runtime.settings?.taskTools?.output ?? defaultCodemodeSettings.taskTools.output,
				executeTool: this.#runtime.executeTool,
				signal: this.#state.signal,
				marshalToolResult,
			}),
			toolCallOk: true,
		}));
	}

	async #deliverToolReply(
		message: Extract<KernelToHostMessage, { type: "tool-call" }>,
		resolve: () => Promise<ResolvedToolReply>,
	): Promise<void> {
		try {
			const reply = await resolve();
			if (!this.#state.active) return;
			this.#state.toolCalls.push({ name: message.toolName, ok: reply.toolCallOk });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: true,
				value: reply.value,
			});
		} catch (error) {
			if (!this.#state.active) return;
			const messageText = error instanceof Error ? error.message : String(error);
			this.#state.toolCalls.push({ name: message.toolName, ok: false, error: messageText });
			this.#kernel.deliverToolReply({
				type: "tool-reply",
				callId: message.callId,
				ok: false,
				error: { message: messageText },
			});
		}
		this.#emitUpdate(false);
	}

	#recordStatus(event: EvalStatusEvent): void {
		const events = this.#state.statusEvents ?? [];
		if (this.#state.statusEvents === undefined) this.#state.statusEvents = events;
		upsertStatusEvent(events, event);
		this.#emitUpdate(false);
	}

	#details(truncated: boolean, isError: boolean): EvalToolDetails {
		return {
			language: this.#state.language,
			title: this.#state.title,
			durationMs: this.#state.durationMs,
			toolCalls: this.#state.toolCalls,
			truncated,
			isError,
			phase: this.#state.phase,
			...(this.#state.statusEvents === undefined ? {} : { statusEvents: this.#state.statusEvents }),
		};
	}

	#emitUpdate(isError: boolean): void {
		if (!this.#state.active) return;
		this.#state.onUpdate?.({
			content: [{ type: "text", text: this.#state.output }],
			details: this.#details(false, isError),
		});
	}
}

function marshalToolResult(result: AgentToolResult<unknown>) {
	const texts: string[] = [];
	const images: Array<{ mimeType: string; dataBase64: string }> = [];
	for (const part of result.content) {
		if (isTextPart(part)) texts.push(part.text);
		if (isRuntimeImagePart(part)) images.push({ mimeType: part.mimeType, dataBase64: part.data });
	}
	const text = texts.join("\n");
	const details = isEmptyObject(result.details) ? undefined : result.details;
	const hasError = toolResultIsError(result);
	if (images.length === 0 && details === undefined && !hasError) return { text };
	return { text, details, images, hasError };
}

function isEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function toolResultIsError(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	return typeof details === "object" && details !== null && "isError" in details && details.isError === true;
}

function isTextPart(part: ToolContent): part is TextPart {
	return part.type === "text";
}

function isRuntimeImagePart(part: unknown): part is RuntimeImagePart {
	return (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "image" &&
		"mimeType" in part &&
		typeof part.mimeType === "string" &&
		"data" in part &&
		typeof part.data === "string"
	);
}
