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
import {
	getOpenAiRemoteCompactionDetails,
	isRecord,
	type OpenAiAssistantMessageItem,
	type OpenAiFunctionCallItem,
	type OpenAiInputContent,
	type OpenAiProviderNativeItem,
	type OpenAiRemoteInputItem,
} from "./openai-remote-schema.ts";

export type {
	OpenAiCompactBody,
	OpenAiContextCompactionItem,
	OpenAiContextCompactionTriggerItem,
	OpenAiRemoteCompactionDetails,
	OpenAiRemoteInputItem,
	OpenAiRemoteTransport,
} from "./openai-remote-schema.ts";
export {
	getOpenAiRemoteCompactionDetails,
	isOpenAiContextCompactionItem,
	isOpenAiRemoteCompactionOutputItem,
	isRecord,
	isRetainedRemoteOutputItem,
	isRetainedResponsesStreamInputItem,
	OPENAI_REMOTE_COMPACTION_SCHEMA,
} from "./openai-remote-schema.ts";

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
