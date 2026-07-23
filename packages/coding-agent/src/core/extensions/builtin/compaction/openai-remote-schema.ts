import type { ServiceTier } from "../../types.ts";
import { type OpenAiRemoteCompactionIdentity, parseOpenAiRemoteCompactionIdentity } from "./openai-remote-model.ts";

export const OPENAI_REMOTE_COMPACTION_SCHEMA = "senpi.compaction.openai-remote.v1";

export type OpenAiInputText = { type: "input_text"; text: string };
export type OpenAiInputImage = { type: "input_image"; detail: "auto"; image_url: string };
export type OpenAiInputContent = OpenAiInputText | OpenAiInputImage;
export type OpenAiOutputText = { type: "output_text"; text: string; annotations: [] };
export type OpenAiMessageInputItem = {
	type?: "message";
	id?: string;
	role: "user" | "system" | "developer";
	content: string | OpenAiInputContent[];
	status?: "in_progress" | "completed" | "incomplete";
};
export type OpenAiAssistantMessageItem = {
	type: "message";
	id: string;
	role: "assistant";
	status: "completed";
	content: OpenAiOutputText[];
	phase?: "commentary" | "final_answer";
};
export type OpenAiFunctionCallItem = {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
};
export type OpenAiFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: string | OpenAiInputContent[];
};
export type OpenAiRemoteTransport = "websocket" | "compact-endpoint";
export type OpenAiCompactionItem = {
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
export type OpenAiProviderNativeItem = Record<string, unknown> & { type: string };
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

export type OpenAiRemoteCompactionDetails = OpenAiRemoteCompactionIdentity & {
	schema: typeof OPENAI_REMOTE_COMPACTION_SCHEMA;
	mode: "openai-remote";
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

export function getOpenAiRemoteCompactionDetails(value: unknown): OpenAiRemoteCompactionDetails | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schema !== OPENAI_REMOTE_COMPACTION_SCHEMA || value.mode !== "openai-remote") return undefined;
	const identity = parseOpenAiRemoteCompactionIdentity(value.provider, value.api);
	if (!identity) return undefined;
	if (typeof value.modelId !== "string" || typeof value.responseId !== "string") return undefined;
	if (typeof value.createdAt !== "number") return undefined;
	if (typeof value.requestInputItemCount !== "number" || typeof value.retainedInputItemCount !== "number") {
		return undefined;
	}
	if (!Array.isArray(value.replacementInput)) return undefined;
	return {
		schema: OPENAI_REMOTE_COMPACTION_SCHEMA,
		mode: "openai-remote",
		...identity,
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
