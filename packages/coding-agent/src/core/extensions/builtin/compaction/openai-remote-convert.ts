import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "../../../messages.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../../session-manager.ts";
import type { ServiceTier } from "../../types.ts";

export const OPENAI_REMOTE_COMPACTION_SCHEMA = "senpi.compaction.openai-remote.v1";

type OpenAiInputText = { type: "input_text"; text: string };
type OpenAiInputImage = { type: "input_image"; detail: "auto"; image_url: string };
type OpenAiInputContent = OpenAiInputText | OpenAiInputImage;
type OpenAiOutputText = { type: "output_text"; text: string; annotations: [] };
type OpenAiMessageInputItem = {
	type?: "message";
	id?: string;
	role: "user" | "system" | "developer";
	content: string | OpenAiInputContent[];
	status?: "in_progress" | "completed" | "incomplete";
};
type OpenAiAssistantMessageItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: OpenAiOutputText[];
	phase?: "commentary" | "final_answer";
};
type OpenAiFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};
type OpenAiFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: string | OpenAiInputContent[];
};
export type OpenAiRemoteTransport = "websocket" | "compact-endpoint";
type OpenAiCompactionItem = {
	type: "compaction";
	encrypted_content: string;
	id?: string | null;
	created_by?: string;
};
export type OpenAiContextCompactionItem = {
	type: "context_compaction";
	encrypted_content: string;
	id?: string | null;
	created_by?: string;
};
export type OpenAiContextCompactionTriggerItem = {
	type: "context_compaction";
};
type OpenAiProviderNativeItem = Record<string, unknown> & { type: string };
export type OpenAiRemoteInputItem =
	| OpenAiMessageInputItem
	| OpenAiAssistantMessageItem
	| OpenAiFunctionCallItem
	| OpenAiFunctionCallOutputItem
	| OpenAiCompactionItem
	| OpenAiContextCompactionItem
	| OpenAiProviderNativeItem;

export type OpenAiCompactBody = {
	model: string;
	input: OpenAiRemoteInputItem[];
	instructions?: string;
	prompt_cache_key?: string;
	service_tier?: ServiceTier;
};

export type OpenAiRemoteCompactionDetails = {
	schema: typeof OPENAI_REMOTE_COMPACTION_SCHEMA;
	mode: "openai-remote";
	provider: "openai";
	api: "openai-responses";
	transport: OpenAiRemoteTransport;
	modelId: string;
	responseId: string;
	createdAt: number;
	requestInputItemCount: number;
	retainedInputItemCount: number;
	replacementInput: OpenAiRemoteInputItem[];
	usage?: Record<string, unknown>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
	if (!value?.startsWith("{")) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: "commentary" | "final_answer" } | undefined {
	if (!signature) return undefined;
	const parsed = parseJsonRecord(signature);
	if (parsed?.v === 1 && typeof parsed.id === "string") {
		if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
			return { id: parsed.id, phase: parsed.phase };
		}
		return { id: parsed.id };
	}
	return { id: signature };
}

function convertUserContent(content: string | (TextContent | ImageContent)[]): OpenAiInputContent[] {
	if (typeof content === "string") return [{ type: "input_text", text: content }];
	return content.map((block): OpenAiInputContent => {
		if (block.type === "text") return { type: "input_text", text: block.text };
		return {
			type: "input_image",
			detail: "auto",
			image_url: `data:${block.mimeType};base64,${block.data}`,
		};
	});
}

export function providerNativeItem(raw: unknown): OpenAiProviderNativeItem | undefined {
	if (!isRecord(raw) || typeof raw.type !== "string") return undefined;
	return { ...raw, type: raw.type };
}

function convertThinking(block: { thinkingSignature?: string }): OpenAiProviderNativeItem | undefined {
	const parsed = parseJsonRecord(block.thinkingSignature);
	if (parsed?.type !== "reasoning") return undefined;
	return { ...parsed, type: "reasoning" };
}

function convertTextBlock(block: TextContent, messageIndex: number): OpenAiAssistantMessageItem {
	const signature = parseTextSignature(block.textSignature);
	const item = {
		type: "message",
		role: "assistant",
		status: "completed",
		id: signature?.id ?? `msg_${messageIndex}`,
		content: [{ type: "output_text", text: block.text, annotations: [] }],
		...(signature?.phase ? { phase: signature.phase } : {}),
	} satisfies OpenAiAssistantMessageItem;
	return item;
}

function convertToolCall(block: ToolCall): OpenAiFunctionCallItem {
	const [callId = block.id, itemId] = block.id.split("|");
	return {
		type: "function_call",
		// The Responses API rejects item ids not beginning with "fc"; custom tool
		// calls carry the "<call_id>|custom" sentinel, not a server-issued id.
		...(itemId?.startsWith("fc") ? { id: itemId } : {}),
		call_id: callId,
		name: block.name,
		arguments: JSON.stringify(block.arguments ?? {}),
	};
}

/**
 * Convert any assistant message — OpenAI Responses-native or foreign — into
 * replayable input items. Native text/reasoning/tool-call items are preserved
 * verbatim; blocks that have no OpenAI Responses representation (foreign
 * thinking, unknown provider-native payloads) are skipped, mirroring what the
 * provider would have received for that message in a normal turn.
 */
function convertAssistantMessage(message: AssistantMessage, messageIndex: number): OpenAiRemoteInputItem[] {
	const items: OpenAiRemoteInputItem[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				items.push(convertTextBlock(block, messageIndex));
				break;
			case "thinking": {
				const reasoning = convertThinking(block);
				if (reasoning) items.push(reasoning);
				break;
			}
			case "toolCall":
				items.push(convertToolCall(block));
				break;
			case "providerNative": {
				const item = providerNativeItem(block.raw);
				if (item) items.push(item);
				break;
			}
		}
	}
	return items;
}

/**
 * Convert a tool result into a function_call_output item, mirroring the
 * Responses API payload builder: image results stay structured for
 * image-capable models and degrade to a text placeholder otherwise.
 */
function convertToolResultMessage(message: ToolResultMessage, model: Model<Api>): OpenAiRemoteInputItem[] {
	const [callId = message.toolCallId] = message.toolCallId.split("|");
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	const images = message.content.filter((block): block is ImageContent => block.type === "image");
	let output: string | OpenAiInputContent[];
	if (images.length > 0 && model.input.includes("image")) {
		const parts: OpenAiInputContent[] = [];
		if (text.length > 0) parts.push({ type: "input_text", text });
		for (const image of images) {
			parts.push({
				type: "input_image",
				detail: "auto",
				image_url: `data:${image.mimeType};base64,${image.data}`,
			});
		}
		output = parts.length > 0 ? parts : "(no tool output)";
	} else {
		output = text.length > 0 ? text : images.length > 0 ? "(see attached image)" : "(no tool output)";
	}
	return [{ type: "function_call_output", call_id: callId, output }];
}

function convertLlmMessage(message: Message, messageIndex: number, model: Model<Api>): OpenAiRemoteInputItem[] {
	switch (message.role) {
		case "user":
			return [{ role: "user", content: convertUserContent(message.content) }];
		case "assistant":
			return convertAssistantMessage(message, messageIndex);
		case "toolResult":
			return convertToolResultMessage(message, model);
	}
}

/**
 * Convert messages that are not yet persisted in the session branch (the
 * in-flight prompt) into input items, so payload replay can append them after
 * the branch-derived items.
 */
export function convertPendingMessages(messages: AgentMessage[], model: Model<Api>): OpenAiRemoteInputItem[] {
	return convertToLlm(messages).flatMap((message, index) => convertLlmMessage(message, index, model));
}

export function getOpenAiRemoteCompactionDetails(value: unknown): OpenAiRemoteCompactionDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schema !== OPENAI_REMOTE_COMPACTION_SCHEMA || value.mode !== "openai-remote") return undefined;
	if (value.provider !== "openai" || value.api !== "openai-responses") return undefined;
	if (typeof value.modelId !== "string" || typeof value.responseId !== "string") return undefined;
	if (typeof value.createdAt !== "number") return undefined;
	if (typeof value.requestInputItemCount !== "number" || typeof value.retainedInputItemCount !== "number") {
		return undefined;
	}
	if (!Array.isArray(value.replacementInput)) return undefined;
	return {
		schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
		mode: "openai-remote",
		provider: "openai",
		api: "openai-responses",
		transport: value.transport === "websocket" ? "websocket" : "compact-endpoint",
		modelId: value.modelId,
		responseId: value.responseId,
		createdAt: value.createdAt,
		requestInputItemCount: value.requestInputItemCount,
		retainedInputItemCount: value.retainedInputItemCount,
		replacementInput: value.replacementInput.filter((item): item is OpenAiRemoteInputItem => isRecord(item)),
		...(isRecord(value.usage) ? { usage: value.usage } : {}),
	};
}

/**
 * Convert session branch entries into OpenAI Responses input items.
 *
 * The route gate is provider capability (checked by the caller), not history
 * provenance: any entry the session can carry is converted through the same
 * pipeline the normal context path uses (`sessionEntryToContextMessages` +
 * `convertToLlm`), so foreign-provider messages, bash executions, branch
 * summaries, and prior local compactions degrade to their canonical text
 * form instead of disqualifying remote compaction. Prior OpenAI remote
 * compaction checkpoints splice their native `replacementInput` in order.
 */
export function convertBranchEntries(entries: SessionEntry[], model: Model<Api>): OpenAiRemoteInputItem[] {
	const items: OpenAiRemoteInputItem[] = [];
	let pendingMessages: AgentMessage[] = [];
	let messageIndex = 0;
	const flush = (): void => {
		for (const message of convertToLlm(pendingMessages)) {
			items.push(...convertLlmMessage(message, messageIndex, model));
			messageIndex++;
		}
		pendingMessages = [];
	};
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const details = getOpenAiRemoteCompactionDetails(entry.details);
			if (details) {
				flush();
				items.push(...details.replacementInput);
				continue;
			}
		}
		pendingMessages.push(...sessionEntryToContextMessages(entry));
	}
	flush();
	return items;
}

export function isOpenAiCompactionItem(item: OpenAiRemoteInputItem): item is OpenAiCompactionItem {
	return item.type === "compaction" && typeof item.encrypted_content === "string";
}

export function isOpenAiContextCompactionItem(item: OpenAiRemoteInputItem): item is OpenAiContextCompactionItem {
	return item.type === "context_compaction" && typeof item.encrypted_content === "string";
}

export function isOpenAiRemoteCompactionOutputItem(
	item: OpenAiRemoteInputItem,
): item is OpenAiCompactionItem | OpenAiContextCompactionItem {
	return isOpenAiCompactionItem(item) || isOpenAiContextCompactionItem(item);
}

export function isRetainedRemoteOutputItem(item: OpenAiRemoteInputItem): boolean {
	if (isOpenAiRemoteCompactionOutputItem(item)) return true;
	return item.type === "message" && (item.role === "user" || item.role === "system" || item.role === "developer");
}

export function isRetainedResponsesStreamInputItem(item: OpenAiRemoteInputItem): boolean {
	if (item.type === "message") return item.role === "user";
	return "role" in item && item.role === "user";
}
