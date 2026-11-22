import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { count } from "./agent-message-schema.ts";
import { malformed } from "./loop-hook-payloads.ts";

// The hand's parse of a reply's stream events as a hosted loop sends them (senpi#5898, `message_update`): every event
// type with the fields it carries, without its assistant message (`partial`, `message`, `error`), which the hand
// holds (`loop-hook-message-stream.ts`). Objects are loose, so a field this schema does not name reaches handlers.

type WithoutMessage<E> = E extends unknown ? Omit<E, "partial" | "message" | "error"> : never;

/** A stream event as the loop sends it: the event without the assistant message it carries. */
export type WireStreamEvent = WithoutMessage<AssistantMessageEvent>;

const toolCall = z.looseObject({
	type: z.literal("toolCall"),
	id: z.string(),
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()),
});
const at = { contentIndex: count };
const event = <T extends AssistantMessageEvent["type"], S extends z.ZodRawShape>(type: T, shape: S) =>
	z.looseObject({ type: z.literal(type), ...shape });

const BY_TYPE = {
	start: event("start", {}),
	text_start: event("text_start", at),
	text_delta: event("text_delta", { ...at, delta: z.string() }),
	text_end: event("text_end", { ...at, content: z.string() }),
	thinking_start: event("thinking_start", at),
	thinking_delta: event("thinking_delta", { ...at, delta: z.string() }),
	thinking_end: event("thinking_end", { ...at, content: z.string() }),
	toolcall_start: event("toolcall_start", at),
	toolcall_delta: event("toolcall_delta", { ...at, delta: z.string() }),
	toolcall_end: event("toolcall_end", { ...at, toolCall }),
	done: event("done", { reason: z.enum(["stop", "length", "toolUse", "deferred"]) }),
	error: event("error", { reason: z.enum(["aborted", "error"]) }),
} satisfies { [T in AssistantMessageEvent["type"]]: z.ZodType };

const wireStreamEventSchema = z.discriminatedUnion("type", [
	BY_TYPE.start,
	BY_TYPE.text_start,
	BY_TYPE.text_delta,
	BY_TYPE.text_end,
	BY_TYPE.thinking_start,
	BY_TYPE.thinking_delta,
	BY_TYPE.thinking_end,
	BY_TYPE.toolcall_start,
	BY_TYPE.toolcall_delta,
	BY_TYPE.toolcall_end,
	BY_TYPE.done,
	BY_TYPE.error,
]);

const isWireStreamEvent = (value: unknown): value is WireStreamEvent => wireStreamEventSchema.safeParse(value).success;

/** The stream event a `message_update` delta carries; refused when malformed. */
export function wireStreamEventOf(value: unknown): WireStreamEvent {
	if (!isWireStreamEvent(value)) throw malformed("message_update");
	return value;
}
