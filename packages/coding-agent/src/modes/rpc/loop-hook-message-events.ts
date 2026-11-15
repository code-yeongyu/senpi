import { isOneOf, isOptional, loopHookFamily, malformed, forwarded } from "./loop-hook-payloads.ts";
import { isAgentMessage, isAgentMessages, isAssistantMessageEvent } from "./loop-hook-message-shapes.ts";

// A hosted loop's messages (senpi#5898): each message's start, per-token update and end (whose handlers may replace the
// message, as in a session), and the two `context` phases before each provider request, each phase returning the
// messages its handlers produced, merged as a session's `emitContext` merges that phase.

const CONTEXT_SOURCES = ["agent", "projection"] as const;

export const MESSAGE_LOOP_HOOKS = loopHookFamily({
	message_start: ({ message }) => {
		if (!isAgentMessage(message)) throw malformed("message_start");
		return forwarded({ type: "message_start", message });
	},
	message_update: ({ message, assistantMessageEvent }) => {
		if (!isAgentMessage(message) || !isAssistantMessageEvent(assistantMessageEvent))
			throw malformed("message_update");
		return forwarded({ type: "message_update", message, assistantMessageEvent });
	},
	message_end: ({ message }) => {
		if (!isAgentMessage(message)) throw malformed("message_end");
		return {
			emit: async ({ runner, only }) => {
				const replaced = await runner.emitMessageEnd({ type: "message_end", message }, only);
				return replaced === undefined ? undefined : { message: replaced };
			},
		};
	},
	context: ({ messages, source }) => {
		if (!isAgentMessages(messages) || !isOptional(source, (value) => isOneOf(value, CONTEXT_SOURCES)))
			throw malformed("context");
		const event = { type: "context" as const, messages, ...(source === undefined ? {} : { source }) };
		return { emit: async ({ runner, only }) => ({ messages: await runner.emitForwardedContext(event, only) }) };
	},
	context_with_system: ({ messages }) => {
		if (!isAgentMessages(messages)) throw malformed("context_with_system");
		const event = { type: "context_with_system" as const, messages };
		return { emit: async ({ runner, only }) => ({ messages: await runner.emitForwardedContext(event, only) }) };
	},
});
