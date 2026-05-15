import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model, TextContent, ToolCall } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../../compaction/index.js";
import type { SessionEntry } from "../../../session-manager.js";
import type { ExtensionContext, ServiceTier, SessionBeforeCompactEvent } from "../../types.js";

export const OPENAI_REMOTE_COMPACTION_SCHEMA = "senpi.compaction.openai-remote.v1";
export const SENPI_COMPACTION_EVENT = "senpi:compaction";

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
type OpenAiCompactionItem = {
	type: "compaction";
	encrypted_content: string;
	id?: string | null;
	created_by?: string;
};
type OpenAiProviderNativeItem = Record<string, unknown> & { type: string };
export type OpenAiRemoteInputItem =
	| OpenAiMessageInputItem
	| OpenAiAssistantMessageItem
	| OpenAiFunctionCallItem
	| OpenAiFunctionCallOutputItem
	| OpenAiCompactionItem
	| OpenAiProviderNativeItem;

type OpenAiCompactBody = {
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
	modelId: string;
	responseId: string;
	createdAt: number;
	requestInputItemCount: number;
	retainedInputItemCount: number;
	replacementInput: OpenAiRemoteInputItem[];
	usage?: Record<string, unknown>;
};

export type OpenAiRemoteCompactionRequest = {
	body: OpenAiCompactBody;
	inputItemCount: number;
	tokensBefore: number;
};

export type OpenAiRemoteCompactionResult = CompactionResult<OpenAiRemoteCompactionDetails> & {
	details: OpenAiRemoteCompactionDetails;
};

type OpenAiCompactedResponse = {
	id: string;
	created_at: number;
	object: "response.compaction";
	output: OpenAiRemoteInputItem[];
	usage?: Record<string, unknown>;
};

type OpenAiRemoteCompactionEvent =
	| {
			version: 1;
			action: "remote_started";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			inputItemCount: number;
	  }
	| {
			version: 1;
			action: "remote_completed";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId: string;
			responseId: string;
			retainedInputItemCount: number;
	  }
	| {
			version: 1;
			action: "remote_fallback";
			route: "builtin.compaction.openai_remote";
			requestId: string;
			modelId?: string;
			reason: string;
	  }
	| {
			version: 1;
			action: "remote_payload_rewritten";
			route: "builtin.compaction.openai_remote";
			modelId: string;
			compactionEntryId: string;
			inputItemCount: number;
	  };

type EmitCompactionEvent = (event: OpenAiRemoteCompactionEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
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

function isOpenAiResponsesModel(model: Model<Api> | undefined): model is Model<"openai-responses"> {
	return model?.provider === "openai" && model.api === "openai-responses";
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

function providerNativeItem(raw: unknown): OpenAiProviderNativeItem | undefined {
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
		...(itemId ? { id: itemId } : {}),
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
		modelId: value.modelId,
		responseId: value.responseId,
		createdAt: value.createdAt,
		requestInputItemCount: value.requestInputItemCount,
		retainedInputItemCount: value.retainedInputItemCount,
		replacementInput: value.replacementInput.filter((item): item is OpenAiRemoteInputItem => isRecord(item)),
		...(isRecord(value.usage) ? { usage: value.usage } : {}),
	};
}

function convertBranchEntries(entries: SessionEntry[]): OpenAiRemoteInputItem[] | undefined {
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

export function createOpenAiRemoteCompactionRequest(options: {
	model: Model<Api> | undefined;
	systemPrompt: string;
	branchEntries: SessionEntry[];
	tokensBefore: number;
	promptCacheKey?: string;
	serviceTier?: ServiceTier;
}): OpenAiRemoteCompactionRequest | undefined {
	if (!isOpenAiResponsesModel(options.model)) return undefined;
	const input = convertBranchEntries(options.branchEntries);
	if (!input || input.length === 0) return undefined;
	return {
		body: {
			model: options.model.id,
			input,
			...(options.systemPrompt ? { instructions: options.systemPrompt } : {}),
			...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
			...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
		},
		inputItemCount: input.length,
		tokensBefore: options.tokensBefore,
	};
}

function isOpenAiCompactionItem(item: OpenAiRemoteInputItem): item is OpenAiCompactionItem {
	return item.type === "compaction" && typeof item.encrypted_content === "string";
}

function isRetainedRemoteOutputItem(item: OpenAiRemoteInputItem): boolean {
	if (isOpenAiCompactionItem(item)) return true;
	return item.type === "message" && (item.role === "user" || item.role === "system" || item.role === "developer");
}

function isOpenAiCompactedResponse(value: unknown): value is OpenAiCompactedResponse {
	if (!isRecord(value)) return false;
	if (value.object !== "response.compaction" || typeof value.id !== "string" || typeof value.created_at !== "number") {
		return false;
	}
	return Array.isArray(value.output);
}

export function buildOpenAiRemoteCompactionResult(options: {
	model: Model<"openai-responses">;
	firstKeptEntryId: string;
	tokensBefore: number;
	requestInputItemCount: number;
	response: OpenAiCompactedResponse;
}): OpenAiRemoteCompactionResult {
	const replacementInput = options.response.output.filter(isRetainedRemoteOutputItem);
	const compactionItem = replacementInput.find(isOpenAiCompactionItem);
	if (!compactionItem) {
		throw new Error("OpenAI remote compaction did not return a compaction item");
	}

	const details = {
		schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
		mode: "openai-remote",
		provider: "openai",
		api: "openai-responses",
		modelId: options.model.id,
		responseId: options.response.id,
		createdAt: options.response.created_at,
		requestInputItemCount: options.requestInputItemCount,
		retainedInputItemCount: replacementInput.length,
		replacementInput,
		...(options.response.usage ? { usage: options.response.usage } : {}),
	} satisfies OpenAiRemoteCompactionDetails;

	return {
		summary: [
			"OpenAI remote compaction checkpoint.",
			`Native /v1/responses/compact replay is active for ${replacementInput.length.toLocaleString()} retained item(s).`,
			`Original OpenAI input items compacted: ${options.requestInputItemCount.toLocaleString()}.`,
		].join("\n"),
		firstKeptEntryId: options.firstKeptEntryId,
		tokensBefore: options.tokensBefore,
		details,
	};
}

function compactEndpointUrl(model: Model<"openai-responses">): string {
	const baseUrl = model.baseUrl || "https://api.openai.com/v1";
	return new URL("responses/compact", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function createHeaders(auth: { apiKey?: string; headers?: Record<string, string> }): Headers | undefined {
	const headers = new Headers(auth.headers);
	headers.set("content-type", "application/json");
	if (!headers.has("authorization") && auth.apiKey) {
		headers.set("authorization", `Bearer ${auth.apiKey}`);
	}
	return headers.has("authorization") ? headers : undefined;
}

export async function runOpenAiRemoteCompaction(
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
	emit?: EmitCompactionEvent,
): Promise<OpenAiRemoteCompactionResult | undefined> {
	const model = ctx.model;
	if (!isOpenAiResponsesModel(model) || event.reason === "branch") {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model?.id,
			reason: event.reason === "branch" ? "branch-compaction" : "not-openai-responses",
		});
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: auth.error,
		});
		return undefined;
	}

	const requestModel = auth.upstreamModelId ? { ...model, id: auth.upstreamModelId } : model;
	const request = createOpenAiRemoteCompactionRequest({
		model: requestModel,
		systemPrompt: ctx.getSystemPrompt(),
		branchEntries: event.branchEntries,
		tokensBefore: event.preparation.tokensBefore,
		promptCacheKey: ctx.sessionManager.getSessionId(),
		serviceTier: ctx.serviceTier ?? auth.serviceTier,
	});
	if (!request) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: "session-not-openai-native",
		});
		return undefined;
	}

	const headers = createHeaders(auth);
	if (!headers) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: model.id,
			reason: "missing-openai-auth",
		});
		return undefined;
	}

	emit?.({
		version: 1,
		action: "remote_started",
		route: "builtin.compaction.openai_remote",
		requestId: event.requestId,
		modelId: requestModel.id,
		inputItemCount: request.inputItemCount,
	});

	let response: Response;
	try {
		response = await fetch(compactEndpointUrl(requestModel), {
			method: "POST",
			headers,
			body: JSON.stringify(request.body),
			signal: event.signal,
		});
	} catch (error) {
		if (event.signal.aborted) throw error;
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			reason: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}

	if (!response.ok) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			reason: `HTTP ${response.status}`,
		});
		return undefined;
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			reason: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (!isOpenAiCompactedResponse(payload)) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			reason: "invalid-compact-response",
		});
		return undefined;
	}

	let result: OpenAiRemoteCompactionResult;
	try {
		result = buildOpenAiRemoteCompactionResult({
			model: requestModel,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			requestInputItemCount: request.inputItemCount,
			response: payload,
		});
	} catch (error) {
		emit?.({
			version: 1,
			action: "remote_fallback",
			route: "builtin.compaction.openai_remote",
			requestId: event.requestId,
			modelId: requestModel.id,
			reason: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	emit?.({
		version: 1,
		action: "remote_completed",
		route: "builtin.compaction.openai_remote",
		requestId: event.requestId,
		modelId: requestModel.id,
		responseId: payload.id,
		retainedInputItemCount: result.details.retainedInputItemCount,
	});
	return result;
}

function latestRemoteCompaction(
	entries: SessionEntry[],
): { entryId: string; index: number; details: OpenAiRemoteCompactionDetails } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "compaction") continue;
		const details = getOpenAiRemoteCompactionDetails(entry.details);
		if (details) return { entryId: entry.id, index, details };
		return undefined;
	}
	return undefined;
}

function leadingPromptMessages(input: unknown): OpenAiRemoteInputItem[] {
	if (!Array.isArray(input)) return [];
	const result: OpenAiRemoteInputItem[] = [];
	for (const item of input) {
		if (!isRecord(item)) break;
		const role = item.role;
		if (role !== "system" && role !== "developer") break;
		result.push(providerNativeItem(item) ?? { role, content: typeof item.content === "string" ? item.content : [] });
	}
	return result;
}

export function rewriteOpenAiPayloadWithRemoteCompaction(
	payload: unknown,
	options: { model: Model<Api> | undefined; branchEntries: SessionEntry[] },
	emit?: EmitCompactionEvent,
): unknown | undefined {
	if (!isOpenAiResponsesModel(options.model) || !isRecord(payload)) return undefined;
	const remote = latestRemoteCompaction(options.branchEntries);
	if (!remote) return undefined;

	const postCompactionItems = convertBranchEntries(options.branchEntries.slice(remote.index + 1));
	if (!postCompactionItems) return undefined;

	const input = [...leadingPromptMessages(payload.input), ...remote.details.replacementInput, ...postCompactionItems];
	emit?.({
		version: 1,
		action: "remote_payload_rewritten",
		route: "builtin.compaction.openai_remote",
		modelId: options.model.id,
		compactionEntryId: remote.entryId,
		inputItemCount: input.length,
	});
	return { ...payload, input };
}
