import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

export type OpenAiResponsesStream = { result(): Promise<AssistantMessage> };
export type OpenAiResponsesStreamRunner = (
	model: Model<"openai-responses">,
	context: Context,
	options: SimpleStreamOptions,
) => OpenAiResponsesStream;

export type SpeculativeJobSettlement = { onSpeculativeJobSettled?: () => void };
