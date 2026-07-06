import type { AgentToolResult, AgentToolUpdateCallback, ToolDefinition } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../host-sdk.ts";
import { buildEvalPrompt } from "../prompt/eval-prompt.ts";
import { renderEvalCall, renderEvalResult } from "./render.ts";
import {
	createEvalInputSchema,
	type EnabledEvalLanguages,
	type EvalKernel,
	type EvalKernelManager,
	type EvalToolDetails,
	type EvalToolInput,
	type ExecuteTool,
	enabledLanguageList,
} from "./types.ts";

export type { EnabledEvalLanguages, EvalKernel, EvalKernelManager } from "./types.ts";

type ImageContent = { type: "image"; mimeType: string; data: string };
type ToolContent = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;
type RuntimeImagePart = { type: "image"; mimeType: string; data: string };

export interface CreateEvalToolOptions {
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly kernelManager: EvalKernelManager;
	readonly cellTimeoutSeconds: number;
	readonly executeTool: ExecuteTool;
}

interface CellState {
	readonly cellId: string;
	readonly language: EvalToolInput["language"];
	readonly title: string | undefined;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<EvalToolDetails> | undefined;
	readonly toolCalls: EvalToolDetails["toolCalls"] extends readonly (infer T)[] ? T[] : never;
	readonly images: ImageContent[];
	readonly pendingBridgeCalls: Promise<void>[];
	output: string;
	phase: string | undefined;
	durationMs: number;
}

export function createEvalTool(
	options: CreateEvalToolOptions,
): ToolDefinition<ReturnType<typeof createEvalInputSchema>, EvalToolDetails> {
	const parameters = createEvalInputSchema(options.enabledLanguages);
	const prompt = buildEvalPrompt(options.enabledLanguages);
	const languages = enabledLanguageList(options.enabledLanguages);
	return {
		name: "eval",
		label: "Eval",
		description: prompt.description,
		promptSnippet: prompt.promptSnippet,
		promptGuidelines: [...prompt.promptGuidelines],
		parameters,
		renderCall: renderEvalCall,
		renderResult: renderEvalResult,
		async execute(toolCallId, params, signal, onUpdate) {
			if (!languages.includes(params.language)) {
				throw new Error(
					`Unsupported eval language "${params.language}". Enabled languages: ${languages.join(", ")}`,
				);
			}
			const state: CellState = {
				cellId: toolCallId,
				language: params.language,
				title: params.title,
				signal,
				onUpdate,
				toolCalls: [],
				images: [],
				pendingBridgeCalls: [],
				output: "",
				phase: undefined,
				durationMs: 0,
			};
			const kernel = await options.kernelManager.getKernel(
				params.language,
				(message) => void handleMessage(message, kernel, state, options.executeTool),
			);
			if (params.reset) await kernel.reset();
			const timeoutMs = Math.floor((params.timeout ?? options.cellTimeoutSeconds) * 1000);
			const result = await kernel.run({ cellId: toolCallId, code: params.code, timeoutMs });
			await Promise.all(state.pendingBridgeCalls);
			return finalizeResult(result, state);
		},
	};
}

async function handleMessage(
	message: KernelToHostMessage,
	kernel: EvalKernel,
	state: CellState,
	executeTool: ExecuteTool,
): Promise<void> {
	if (message.type === "text") {
		state.output += message.data;
		emitUpdate(state, false);
		return;
	}
	if (message.type === "phase") {
		state.phase = message.title;
		emitUpdate(state, false);
		return;
	}
	if (message.type === "log") {
		state.output += `${message.message}\n`;
		emitUpdate(state, false);
		return;
	}
	if (message.type === "display") {
		state.images.push({ type: "image", mimeType: message.mimeType, data: message.dataBase64 });
		state.output += `[display: ${message.mimeType}]\n`;
		emitUpdate(state, false);
		return;
	}
	if (message.type === "tool-call") {
		const pending = handleToolCall(message, kernel, state, executeTool);
		state.pendingBridgeCalls.push(pending);
		await pending;
	}
}

async function handleToolCall(
	message: Extract<KernelToHostMessage, { type: "tool-call" }>,
	kernel: EvalKernel,
	state: CellState,
	executeTool: ExecuteTool,
): Promise<void> {
	if (message.toolName === "eval") {
		const error = "recursive eval is not allowed";
		state.toolCalls.push({ name: message.toolName, ok: false, error });
		kernel.deliverToolReply({ type: "tool-reply", callId: message.callId, ok: false, error: { message: error } });
		return;
	}
	try {
		const result = await executeTool(message.toolName, message.args, { signal: state.signal });
		state.toolCalls.push({ name: message.toolName, ok: !toolResultIsError(result) });
		kernel.deliverToolReply({
			type: "tool-reply",
			callId: message.callId,
			ok: true,
			value: marshalToolResult(result),
		});
	} catch (error) {
		const messageText = errorMessage(error);
		state.toolCalls.push({ name: message.toolName, ok: false, error: messageText });
		kernel.deliverToolReply({
			type: "tool-reply",
			callId: message.callId,
			ok: false,
			error: { message: messageText },
		});
	}
	emitUpdate(state, false);
}

function marshalToolResult(result: AgentToolResult<unknown>): unknown {
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

function finalizeResult(
	result: Extract<KernelToHostMessage, { type: "result" }>,
	state: CellState,
): AgentToolResult<EvalToolDetails> {
	state.durationMs = result.durationMs;
	if (result.ok && result.valueRepr) state.output += `${result.valueRepr}\n`;
	if (!result.ok) state.output += `${result.error.message}\n`;
	const truncation = truncateTail(state.output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	const suffix = truncation.truncated
		? `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.outputBytes} of ${truncation.totalBytes} bytes).]`
		: "";
	const details = detailsFor(state, truncation.truncated, !result.ok);
	return {
		content: [{ type: "text", text: `${truncation.content}${suffix}` }, ...state.images],
		details,
	};
}

function detailsFor(state: CellState, truncated: boolean, isError: boolean): EvalToolDetails {
	return {
		language: state.language,
		title: state.title,
		durationMs: state.durationMs,
		toolCalls: state.toolCalls,
		truncated,
		isError,
		phase: state.phase,
	};
}

function emitUpdate(state: CellState, isError: boolean): void {
	state.onUpdate?.({
		content: [{ type: "text", text: state.output }],
		details: detailsFor(state, false, isError),
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
