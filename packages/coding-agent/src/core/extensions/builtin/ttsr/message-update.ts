import type { MessageUpdateEvent } from "../../types.ts";
import type { TtsrStreamSource } from "./types.ts";

function assertNever(value: never): never {
	throw new Error(`unexpected assistant message event: ${String(value)}`);
}

export interface TtsrStreamDelta {
	readonly source: TtsrStreamSource;
	readonly streamKey: string;
	readonly delta: string;
	readonly toolName?: string;
}

export function getTtsrStreamDelta(event: MessageUpdateEvent): TtsrStreamDelta | null {
	const deltaEvent = event.assistantMessageEvent;
	switch (deltaEvent.type) {
		case "text_delta":
			return { source: "text", streamKey: `text:${String(deltaEvent.contentIndex)}`, delta: deltaEvent.delta };
		case "thinking_delta":
			return {
				source: "thinking",
				streamKey: `thinking:${String(deltaEvent.contentIndex)}`,
				delta: deltaEvent.delta,
			};
		case "toolcall_delta": {
			const block = deltaEvent.partial.content[deltaEvent.contentIndex];
			return {
				source: "tool",
				streamKey: `tool:${String(deltaEvent.contentIndex)}`,
				delta: deltaEvent.delta,
				toolName: block?.type === "toolCall" ? block.name : undefined,
			};
		}
		case "start":
		case "text_start":
		case "text_end":
		case "thinking_start":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_end":
		case "done":
		case "error":
			return null;
		default:
			return assertNever(deltaEvent);
	}
}
