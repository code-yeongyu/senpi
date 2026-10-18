import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OpenAiRemoteCompactionModel } from "./openai-remote-model.ts";

export type OpenAiResponsesStream = { result(): Promise<AssistantMessage> };
export type OpenAiResponsesStreamRunner = (
	model: OpenAiRemoteCompactionModel,
	context: Context,
	options: SimpleStreamOptions,
) => OpenAiResponsesStream;

export type SpeculativeJobSettlement = { onSpeculativeJobSettled?: () => void };
