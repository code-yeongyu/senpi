import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

function cloneToolCall(toolCall: ToolCall): ToolCall {
	const clone: ToolCall & { partialJson?: string } = { ...toolCall, arguments: { ...toolCall.arguments } };
	delete clone.partialJson;
	return clone;
}

function cloneMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) => (block.type === "toolCall" ? cloneToolCall(block) : { ...block })),
		usage: { ...message.usage, cost: { ...message.usage.cost } },
		...(message.diagnostics === undefined ? {} : { diagnostics: [...message.diagnostics] }),
	};
}

function cloneEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: cloneMessage(event.message) };
		case "error":
			return { ...event, error: cloneMessage(event.error) };
		case "toolcall_end":
			return { ...event, toolCall: cloneToolCall(event.toolCall), partial: cloneMessage(event.partial) };
		default:
			return { ...event, partial: cloneMessage(event.partial) };
	}
}

/** Recovery events carry immutable message snapshots for their corresponding source event. */
export class RecoveryAssistantMessageEventStream extends AssistantMessageEventStream {
	private cancellationHandler: (() => void) | undefined;
	private cancelled = false;

	setCancellationHandler(handler: () => void): void {
		this.cancellationHandler = handler;
	}

	override push(event: AssistantMessageEvent): void {
		super.push(cloneEvent(event));
	}

	override [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		const iterator = super[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				if (!this.cancelled) {
					this.cancelled = true;
					this.cancellationHandler?.();
				}
				return { value: undefined, done: true };
			},
		};
	}
}
