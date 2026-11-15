import { isOneOf, isOptional, loopHookFamily, malformed, forwarded } from "./loop-hook-payloads.ts";
import { isAgentMessage, isAgentMessages } from "./agent-message-schema.ts";
import { messageUpdateOf } from "./loop-hook-message-stream.ts";

// A hosted loop's messages (senpi#5898): each message's start, per-token update (a delta, review L3) and end (whose handlers may replace the
// message, as in a session), and the two `context` phases before each provider request, each phase returning the
// messages its handlers produced, merged as a session's `emitContext` merges that phase.

const CONTEXT_SOURCES = ["agent", "projection"] as const;

export const MESSAGE_LOOP_HOOKS = loopHookFamily({
	message_start: ({ message }) => {
		if (!isAgentMessage(message)) throw malformed("message_start");
		return forwarded({ type: "message_start", message });
	},
	message_update: (payload, { sessionId, streams }) => {
		// A delta against the message the hand holds for this session's stream (`loop-hook-message-stream.ts`).
		const step = messageUpdateOf(payload, streams.held(sessionId));
		switch (step.kind) {
			case "resync_required":
				// No handler runs: the loop sends this update again whole, and the handlers see it once.
				return { emit: async () => ({ resync_required: true }) };
			case "update":
				if (step.next === undefined) streams.end(sessionId);
				else streams.hold(sessionId, step.next);
				return forwarded({ type: "message_update", ...step.event });
		}
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
