import {
	type Context,
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	getInitialSystemMessage,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * Replay a provider transcript into the `{ systemPrompt, tools, messages }` shape the fork's subscription
 * providers read. `tools` stays undefined only when the transcript has no system message at all.
 */
export function toBuiltinProviderContext(context: TranscriptContext): Context {
	const transcript = collapseSystemMessages(context);
	const head = getInitialSystemMessage(transcript.messages);
	const messages = transcript.messages.filter((message): message is Message => message.role !== "system");
	const systemPrompt = head ? getCurrentSystemPrompt(transcript.messages) : "";
	return {
		...(systemPrompt.length > 0 ? { systemPrompt } : {}),
		messages,
		...(head ? { tools: getCurrentTools(transcript.messages) } : {}),
		...(context.activeToolNames ? { activeToolNames: context.activeToolNames } : {}),
	};
}
