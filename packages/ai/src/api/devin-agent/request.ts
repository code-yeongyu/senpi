/**
 * Builds the Cascade `GetChatMessage` request from senpi's provider-neutral
 * context.
 *
 * Cascade has no system role: the system prompt travels in the top-level
 * `prompt` field, and history is a flat list of `ChatMessagePrompt` entries
 * whose `source` carries the role. Message ids must be UUID-shaped; they are
 * derived deterministically from the conversation id and the entry index so a
 * retried turn re-sends the same ids instead of forking the server-side
 * transcript, while a native Devin turn is replayed under the id the server
 * minted for it.
 */

import { create } from "@bufbuild/protobuf";
import type { Context, Message, Model, Tool } from "../../types.ts";
import { deterministicUuid } from "../cursor-agent/deterministic-id.ts";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatMessageRequestType,
	ChatMessageSource,
	ChatToolCallSchema,
	ChatToolDefinitionSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	type GetChatMessageRequest,
	GetChatMessageRequestSchema,
	type ImageData,
	ImageDataSchema,
	PromptCacheOptionsSchema,
} from "./gen/cascade_pb.ts";
import { devinCliMetadata } from "./metadata.ts";

/** Cascade's own stop vocabulary; the server echoes these as STOP_PATTERN. */
export const DEVIN_DEFAULT_STOP_PATTERNS = [
	"<|user|>",
	"<|bot|>",
	"<|context_request|>",
	"<|endoftext|>",
	"<|end_of_turn|>",
] as const;

const DEFAULT_MAX_TOKENS = 64_000;
const DEFAULT_TEMPERATURE = 0.4;
/** Cascade refuses a temperature of exactly 0 (proto3 drops it) with an opaque invalid_argument. */
const MIN_TEMPERATURE = 0.0001;

export interface DevinModelAssignment {
	modelUid: string;
	assignmentJwt: string;
}

export interface DevinChatRequestInput {
	model: Model<"devin-agent">;
	context: Context;
	apiKey: string | undefined;
	userJwt?: string;
	cascadeId: string;
	assignment?: DevinModelAssignment;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stopSequences?: readonly string[];
}

type UserMessage = Extract<Message, { role: "user" }>;
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

export function buildDevinChatRequest(input: DevinChatRequestInput): GetChatMessageRequest {
	const temperature = Math.max(input.temperature ?? DEFAULT_TEMPERATURE, MIN_TEMPERATURE);
	const stopPatterns = [...DEVIN_DEFAULT_STOP_PATTERNS, ...(input.stopSequences ?? [])];
	return create(GetChatMessageRequestSchema, {
		metadata: devinCliMetadata(input.apiKey, input.userJwt ?? ""),
		prompt: input.context.systemPrompt ?? "",
		chatMessagePrompts: mapHistory(input.context.messages, input.cascadeId, input.model),
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		chatModelUid: input.assignment?.modelUid ?? input.model.upstreamModelId ?? input.model.id,
		...(input.assignment ? { modelAssignmentJwt: input.assignment.assignmentJwt } : {}),
		cascadeId: input.cascadeId,
		executionId: crypto.randomUUID(),
		tools: (input.context.tools ?? []).map(toolDefinition),
		toolChoice: { choice: { case: "optionName", value: "auto" } },
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: input.model.compat?.supportsParallelToolCalls !== true,
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(input.maxTokens ?? input.model.maxTokens ?? DEFAULT_MAX_TOKENS),
			maxNewlines: 200n,
			temperature,
			firstTemperature: temperature,
			topK: 50n,
			topP: input.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
	});
}

/** The router scores the latest user turn alone; the chat request mints the turn's id. */
export function buildDevinRouterPrompt(messages: readonly Message[]): ChatMessagePrompt | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") return userPrompt(message, "");
	}
	return undefined;
}

function toolDefinition(tool: Tool) {
	return create(ChatToolDefinitionSchema, {
		name: tool.name,
		description: tool.description,
		jsonSchemaString: JSON.stringify(tool.parameters ?? {}),
		strict: false,
	});
}

function mapHistory(messages: readonly Message[], cascadeId: string, model: Model<"devin-agent">): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	for (const [index, message] of messages.entries()) {
		const seed = `${cascadeId}\u0000${index}\u0000${message.role}`;
		if (message.role === "user") prompts.push(userPrompt(message, deterministicUuid(seed)));
		else if (message.role === "assistant") {
			const prompt = assistantPrompt(message, model, `bot-${deterministicUuid(seed)}`);
			if (prompt) prompts.push(prompt);
		} else if (message.role === "toolResult") {
			prompts.push(toolResultPrompt(message, deterministicUuid(`${seed}\u0000${message.toolCallId}`)));
		}
	}
	return prompts;
}

function userPrompt(message: UserMessage, messageId: string): ChatMessagePrompt {
	const { text, images } = splitContent(typeof message.content === "string" ? [] : message.content);
	return create(ChatMessagePromptSchema, {
		messageId,
		source: ChatMessageSource.USER,
		prompt: typeof message.content === "string" ? message.content : text,
		images,
	});
}

function assistantPrompt(
	message: AssistantMessage,
	model: Model<"devin-agent">,
	fallbackId: string,
): ChatMessagePrompt | undefined {
	const native = message.api === model.api && message.provider === model.provider && message.model === model.id;
	let text = "";
	let thinking = "";
	let signature = "";
	const toolCalls = [];
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") {
			thinking += block.thinking;
			if (native && !signature && block.thinkingSignature) signature = block.thinkingSignature;
		} else if (block.type === "toolCall") {
			toolCalls.push(
				create(ChatToolCallSchema, {
					id: block.id,
					name: block.name,
					argumentsJson: JSON.stringify(block.arguments ?? {}),
				}),
			);
		}
	}
	if (!text && !thinking && !signature && toolCalls.length === 0) return undefined;
	return create(ChatMessagePromptSchema, {
		messageId: native && message.responseId ? message.responseId : fallbackId,
		source: ChatMessageSource.SYSTEM,
		prompt: text,
		thinking,
		signature,
		signatureType: "",
		toolCalls,
	});
}

function toolResultPrompt(message: ToolResultMessage, messageId: string): ChatMessagePrompt {
	const { text, images } = splitContent(message.content);
	return create(ChatMessagePromptSchema, {
		messageId,
		source: ChatMessageSource.TOOL,
		prompt: text,
		images,
		toolCallId: message.toolCallId,
		toolResultIsError: message.isError === true,
	});
}

function splitContent(
	content: readonly ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[],
): { text: string; images: ImageData[] } {
	let text = "";
	const images: ImageData[] = [];
	for (const block of content) {
		if (block.type === "text") text += block.text;
		else images.push(create(ImageDataSchema, { base64Data: block.data, mimeType: block.mimeType }));
	}
	return { text, images };
}
