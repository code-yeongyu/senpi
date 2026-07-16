import { type Content, ThinkingLevel as GoogleGenAIThinkingLevel, type ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityHeaders,
	getGeminiCliHeaders,
} from "../providers/google-gemini-headers.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { GoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapToolChoice,
	retainThoughtSignature,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, GoogleGenAIThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: GoogleGenAIThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: GoogleGenAIThinkingLevel.MINIMAL,
	LOW: GoogleGenAIThinkingLevel.LOW,
	MEDIUM: GoogleGenAIThinkingLevel.MEDIUM,
	HIGH: GoogleGenAIThinkingLevel.HIGH,
};

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: { enabled: boolean; budgetTokens?: number; level?: GoogleThinkingLevel };
}

interface Credentials {
	token: string;
	projectId: string;
}
interface CcaRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: ThinkingConfig };
		tools?: { functionDeclarations: Record<string, unknown>[] }[];
		toolConfig?: { functionCallingConfig: { mode: ReturnType<typeof mapToolChoice> } };
		preambleConfig?: { mode: "SYSTEM_INSTRUCTION_MODE_REPLACE" };
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}
interface CcaChunk {
	response?: {
		candidates?: Array<{
			content?: {
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: { name?: string; args?: Record<string, unknown>; id?: string };
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			cachedContentTokenCount?: number;
			totalTokenCount?: number;
		};
	};
}

export function parseGoogleCcaCredentials(raw: string | undefined): Credentials {
	if (!raw) throw new Error("Google Cloud Code Assist requires OAuth credentials");
	let value: { token?: unknown; projectId?: unknown };
	try {
		value = JSON.parse(raw) as typeof value;
	} catch {
		throw new Error("Invalid Google Cloud Code Assist credentials");
	}
	if (typeof value.token !== "string" || !value.token)
		throw new Error("Google Cloud Code Assist credentials are missing token");
	if (typeof value.projectId !== "string" || !value.projectId.trim())
		throw new Error("Google Cloud Code Assist credentials are missing projectId");
	return { token: value.token, projectId: value.projectId };
}

export function buildGoogleCcaRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
): CcaRequest {
	if (!projectId.trim()) throw new Error("Google Cloud Code Assist projectId must not be empty");
	const request: CcaRequest["request"] = { contents: convertMessages(model, context) };
	const system = Array.isArray(context.systemPrompt)
		? context.systemPrompt
		: context.systemPrompt
			? [context.systemPrompt]
			: [];
	if (system.length)
		request.systemInstruction = {
			...(model.provider === "google-antigravity" && { role: "user" }),
			parts: system.map((text) => ({ text })),
		};
	if (
		model.provider === "google-antigravity" &&
		(model.id.toLowerCase().includes("claude") || model.id.toLowerCase().includes("gemini-3"))
	) {
		request.systemInstruction = {
			role: "user",
			parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...(request.systemInstruction?.parts ?? [])],
		};
	}
	if (options.maxTokens !== undefined || options.temperature !== undefined || options.thinking?.enabled)
		request.generationConfig = {
			...(options.maxTokens !== undefined && { maxOutputTokens: options.maxTokens }),
			...(options.temperature !== undefined && { temperature: options.temperature }),
			...(options.thinking?.enabled &&
				model.reasoning && {
					thinkingConfig: {
						includeThoughts: true,
						...(options.thinking.level !== undefined
							? { thinkingLevel: THINKING_LEVEL_MAP[options.thinking.level] }
							: options.thinking.budgetTokens !== undefined
								? { thinkingBudget: options.thinking.budgetTokens }
								: {}),
					},
				}),
		};
	if (context.tools?.length) {
		request.tools = convertTools(
			context.tools,
			model.provider === "google-antigravity" && model.id.startsWith("claude-"),
		);
		if (options.toolChoice)
			request.toolConfig = { functionCallingConfig: { mode: mapToolChoice(options.toolChoice) } };
	}
	if (model.provider === "google-antigravity") {
		request.sessionId = `-${crypto.getRandomValues(new BigUint64Array(1))[0]! & ((1n << 63n) - 1n)}`;
		request.preambleConfig = { mode: "SYSTEM_INSTRUCTION_MODE_REPLACE" };
	}
	return {
		project: projectId,
		model: model.id,
		request,
		...(model.provider === "google-antigravity" && {
			requestType: "agent",
			userAgent: "antigravity",
			requestId: `agent-${crypto.randomUUID()}`,
		}),
	};
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<CcaChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = /\r?\n\r?\n/.exec(buffer);
			while (boundary !== null) {
				const event = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const data = event
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n");
				if (data && data !== "[DONE]") yield JSON.parse(data) as CcaChunk;
				boundary = /\r?\n\r?\n/.exec(buffer);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export const stream: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (model, context, options) => {
	const events = new AssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			const credentials = parseGoogleCcaCredentials(options?.apiKey);
			let body = buildGoogleCcaRequest(model, context, credentials.projectId, options);
			const replacement = await options?.onPayload?.(body, model);
			if (replacement !== undefined) body = replacement as CcaRequest;
			const headers = {
				Authorization: `Bearer ${credentials.token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...(model.provider === "google-antigravity" ? getAntigravityHeaders() : getGeminiCliHeaders(model.id)),
				...(options?.headers ?? {}),
			};
			const response = await fetch(`${model.baseUrl}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			if (!response.ok) throw new Error(`Cloud Code Assist API error (${response.status})`);
			if (!response.body) throw new Error("Cloud Code Assist API returned no response body");
			events.push({ type: "start", partial: output });
			let current: TextContent | ThinkingContent | undefined;
			const finishCurrent = () => {
				const block = current;
				if (!block) return;
				const contentIndex = output.content.indexOf(block);
				if (block.type === "thinking") {
					events.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else {
					events.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				}
				current = undefined;
			};
			for await (const chunk of parseSse(response.body, options?.signal)) {
				const candidate = chunk.response?.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						const thinking = isThinkingPart(part);
						if (!current || (thinking ? current.type !== "thinking" : current.type !== "text")) {
							finishCurrent();
							current = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
							output.content.push(current);
							events.push({
								type: thinking ? "thinking_start" : "text_start",
								contentIndex: output.content.length - 1,
								partial: output,
							});
						}
						if (current.type === "thinking") {
							current.thinking += part.text;
							current.thinkingSignature = retainThoughtSignature(
								current.thinkingSignature,
								part.thoughtSignature,
							);
							events.push({
								type: "thinking_delta",
								contentIndex: output.content.length - 1,
								delta: part.text,
								partial: output,
							});
						} else {
							current.text += part.text;
							current.textSignature = retainThoughtSignature(current.textSignature, part.thoughtSignature);
							events.push({
								type: "text_delta",
								contentIndex: output.content.length - 1,
								delta: part.text,
								partial: output,
							});
						}
					}
					if (part.functionCall) {
						finishCurrent();
						const tool: ToolCall = {
							type: "toolCall",
							id: part.functionCall.id ?? crypto.randomUUID(),
							name: part.functionCall.name ?? "",
							arguments: part.functionCall.args ?? {},
						};
						output.content.push(tool);
						events.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
						events.push({
							type: "toolcall_delta",
							contentIndex: output.content.length - 1,
							delta: JSON.stringify(tool.arguments),
							partial: output,
						});
						events.push({
							type: "toolcall_end",
							contentIndex: output.content.length - 1,
							toolCall: tool,
							partial: output,
						});
					}
				}
				if (candidate?.finishReason === "MAX_TOKENS") output.stopReason = "length";
				if (output.content.some((part) => part.type === "toolCall")) output.stopReason = "toolUse";
				const usage = chunk.response?.usageMetadata;
				if (usage) {
					output.usage.input = (usage.promptTokenCount ?? 0) - (usage.cachedContentTokenCount ?? 0);
					output.usage.cacheRead = usage.cachedContentTokenCount ?? 0;
					output.usage.output = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
					output.usage.totalTokens = usage.totalTokenCount ?? 0;
					calculateCost(model, output.usage);
				}
			}
			finishCurrent();
			const reason = output.stopReason === "length" || output.stopReason === "toolUse" ? output.stopReason : "stop";
			output.stopReason = reason;
			events.push({ type: "done", reason, message: output });
			events.end(output);
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			events.push({ type: "error", reason: output.stopReason, error: output });
			events.end(output);
		}
	})();
	return events;
};

type ClampedThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

function isGemini3ProModel(model: Pick<Model<Api>, "id">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Pick<Model<Api>, "id">): boolean {
	return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getGemini3ThinkingLevel(effort: ClampedThinkingLevel, model: Pick<Model<Api>, "id">): GoogleThinkingLevel {
	if (isGemini3ProModel(model)) {
		return effort === "minimal" || effort === "low" ? "LOW" : "HIGH";
	}
	return effort.toUpperCase() as GoogleThinkingLevel;
}

function getGoogleBudget(
	model: Pick<Model<Api>, "id">,
	effort: ClampedThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[effort] !== undefined) return customBudgets[effort];
	if (model.id.includes("2.5-pro")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort];
	}
	if (model.id.includes("2.5-flash-lite")) {
		return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[effort];
	}
	if (model.id.includes("2.5-flash")) {
		return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort];
	}
	return -1;
}

export const streamSimple: StreamFunction<"google-gemini-cli", SimpleStreamOptions> = (model, context, options) => {
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	if (!options?.reasoning || !model.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleGeminiCliOptions);
	}

	const clamped = clampThinkingLevel(model, options.reasoning);
	const effort: ClampedThinkingLevel =
		clamped === "minimal" || clamped === "low" || clamped === "medium" ? clamped : "high";
	if (isGemini3ProModel(model) || isGemini3FlashModel(model)) {
		return stream(model, context, {
			...base,
			thinking: { enabled: true, level: getGemini3ThinkingLevel(effort, model) },
		} satisfies GoogleGeminiCliOptions);
	}

	return stream(model, context, {
		...base,
		thinking: { enabled: true, budgetTokens: getGoogleBudget(model, effort, options.thinkingBudgets) },
	} satisfies GoogleGeminiCliOptions);
};
