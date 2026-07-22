import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../../session-manager.ts";
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
	output: string;
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

function toolResultText(content: string | TextContent[] | (TextContent | ImageContent)[]): string | undefined {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type !== "text") return undefined;
		parts.push(block.text);
	}
	return parts.join("\n");
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

function isSameOpenAiResponsesAssistant(message: AssistantMessage): boolean {
	return message.provider === "openai" && message.api === "openai-responses";
}

function convertAssistantMessage(message: AssistantMessage, messageIndex: number): OpenAiRemoteInputItem[] | undefined {
	if (!isSameOpenAiResponsesAssistant(message)) return undefined;

	const items: OpenAiRemoteInputItem[] = [];
	for (const block of message.content) {
		switch (block.type) {
			case "text":
				items.push(convertTextBlock(block, messageIndex));
				break;
			case "thinking": {
				const reasoning = convertThinking(block);
				if (!reasoning) return undefined;
				items.push(reasoning);
				break;
			}
			case "toolCall":
				items.push(convertToolCall(block));
				break;
			case "providerNative": {
				const item = providerNativeItem(block.raw);
				if (!item) return undefined;
				items.push(item);
				break;
			}
		}
	}
	return items.length > 0 ? items : undefined;
}

function convertAgentMessage(message: AgentMessage, messageIndex: number): OpenAiRemoteInputItem[] | undefined {
	switch (message.role) {
		case "user":
			return [{ role: "user", content: convertUserContent(message.content) }];
		case "assistant":
			return convertAssistantMessage(message, messageIndex);
		case "toolResult": {
			const [callId = message.toolCallId] = message.toolCallId.split("|");
			const output = toolResultText(message.content);
			if (output === undefined) return undefined;
			return [{ type: "function_call_output", call_id: callId, output }];
		}
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
		case "custom":
			return undefined;
		default: {
			const exhaustive: never = message;
			return exhaustive;
		}
	}
}

function detailsFromEntry(entry: SessionEntry): OpenAiRemoteCompactionDetails | undefined {
	if (entry.type !== "compaction") return undefined;
	return getOpenAiRemoteCompactionDetails(entry.details);
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

export function convertBranchEntries(entries: SessionEntry[]): OpenAiRemoteInputItem[] | undefined {
	const items: OpenAiRemoteInputItem[] = [];
	let messageIndex = 0;
	for (const entry of entries) {
		switch (entry.type) {
			case "message": {
				const converted = convertAgentMessage(entry.message, messageIndex);
				if (!converted) return undefined;
				items.push(...converted);
				messageIndex++;
				break;
			}
			case "compaction": {
				const details = detailsFromEntry(entry);
				if (!details) return undefined;
				items.push(...details.replacementInput);
				break;
			}
			case "branch_summary":
			case "custom_message":
				return undefined;
			case "thinking_level_change":
			case "model_change":
			case "custom":
			case "label":
			case "session_info":
				break;
		}
	}
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
