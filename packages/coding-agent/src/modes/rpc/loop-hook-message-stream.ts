import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { MessageUpdateEvent } from "../../core/extensions/types.ts";
import { isAgentMessage, isCount } from "./agent-message-schema.ts";
import { type WireStreamEvent, wireStreamEventOf } from "./assistant-stream-schema.ts";
import { isRecord, malformed } from "./loop-hook-payloads.ts";

// A hosted loop's `message_update` stream (senpi#5898, review L3). A stream is append-only, so the loop sends each
// update as a delta and the hand holds the assistant message being streamed, per loop session:
// - `seq` numbers every `message_update` the loop emits for the session, forwarded or not (review L7). A delta applies
//   only right after the update the hand holds (`seq` one more); any other delta, after a gap in forwarding (`wants`
//   dropped the stream for a while) or a hand restart, gets the reply `{ resync_required: true }` and runs no handler.
//   The loop answers it by sending that same update again with the whole `message`, which the hand accepts at any
//   `seq`;
// - `assistantMessageEvent` is the event without its assistant message (`partial`, or `message` / `error` at the end);
// - `message` (the whole message) comes with `start`, `done` and `error`, and with any update when the loop resyncs;
// - otherwise `envelope` (the message without `content`) comes with every update, and `block` (the content block at
//   `contentIndex`, as it now is) with every update that is not a `text_delta` or `thinking_delta`: those append their
//   `delta` to the held block, as the provider's stream does.
// Each part is checked once, when it arrives, against the transcript schema; the handlers then get the event a
// session's emit gives them (`message` a copy of the partial, `assistantMessageEvent.partial` the partial).

/** An assistant message the hand holds while it streams, and the `seq` of the update that produced it. */
export interface HeldStream {
	readonly message: AssistantMessage;
	readonly seq: number;
}

/** The assistant messages the hand holds while they stream, one per loop session. */
export interface MessageStreams {
	held(sessionId: string): HeldStream | undefined;
	hold(sessionId: string, stream: HeldStream): void;
	end(sessionId: string): void;
}

export function createMessageStreams(): MessageStreams {
	const streams = new Map<string, HeldStream>();
	return {
		held: (sessionId) => streams.get(sessionId),
		hold: (sessionId, stream) => void streams.set(sessionId, stream),
		end: (sessionId) => void streams.delete(sessionId),
	};
}

const isAssistantMessage = (value: unknown): value is AssistantMessage =>
	isAgentMessage(value) && value.role === "assistant";

type Envelope = Omit<AssistantMessage, "content">;

function envelopeOf(value: unknown): Envelope {
	if (!isRecord(value) || "content" in value) throw malformed("message_update");
	const checked = { ...value, content: [] };
	if (!isAssistantMessage(checked)) throw malformed("message_update");
	const { content: _content, ...envelope } = checked;
	return envelope;
}

/** The held message after one delta, or a refusal when the delta does not fit the held message. */
function applied(held: AssistantMessage, update: Record<string, unknown>, event: WireStreamEvent): AssistantMessage {
	if (!("contentIndex" in event) || event.contentIndex > held.content.length) throw malformed("message_update");
	const envelope = envelopeOf(update.envelope);
	const content = held.content.slice();
	const { block } = update;
	if (block !== undefined) {
		const checked = { ...envelope, content: [block] };
		const checkedBlock = isAssistantMessage(checked) ? checked.content[0] : undefined;
		if (checkedBlock === undefined) throw malformed("message_update");
		content[event.contentIndex] = checkedBlock;
		return { ...envelope, content };
	}
	const current = content[event.contentIndex];
	if (event.type === "text_delta" && current?.type === "text")
		content[event.contentIndex] = { ...current, text: current.text + event.delta };
	else if (event.type === "thinking_delta" && current?.type === "thinking")
		content[event.contentIndex] = { ...current, thinking: current.thinking + event.delta };
	else throw malformed("message_update");
	return { ...envelope, content };
}

function eventFor(event: WireStreamEvent, partial: AssistantMessage): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: partial };
		case "error":
			return { ...event, error: partial };
		default:
			return { ...event, partial };
	}
}

/** A forwarded `message_update`, parsed against what the hand holds for its session. */
export type MessageUpdateStep =
	| {
			readonly kind: "update";
			readonly event: Omit<MessageUpdateEvent, "type">;
			/** What to hold next; `undefined` once the stream ended. */
			readonly next: HeldStream | undefined;
	  }
	/** A delta that does not follow what is held: the loop must send this update again with its whole `message`. */
	| { readonly kind: "resync_required" };

/**
 * The `message_update` a forwarded update stands for, given the stream the hand holds for its session. Throws when the
 * update is malformed, or when a delta that does follow the held update does not fit it (a loop that numbers its
 * updates but sends a wrong delta).
 */
export function messageUpdateOf(update: Record<string, unknown>, held: HeldStream | undefined): MessageUpdateStep {
	const event = wireStreamEventOf(update.assistantMessageEvent);
	const { seq } = update;
	if (!isCount(seq)) throw malformed("message_update");
	const ends = event.type === "done" || event.type === "error";
	let partial: AssistantMessage;
	if (update.message !== undefined) {
		if (!isAssistantMessage(update.message)) throw malformed("message_update");
		partial = update.message;
	} else if (event.type === "start" || ends) throw malformed("message_update");
	else if (held === undefined || seq !== held.seq + 1) return { kind: "resync_required" };
	else partial = applied(held.message, update, event);
	return {
		kind: "update",
		event: { message: { ...partial }, assistantMessageEvent: eventFor(event, partial) },
		next: ends ? undefined : { message: partial, seq },
	};
}
