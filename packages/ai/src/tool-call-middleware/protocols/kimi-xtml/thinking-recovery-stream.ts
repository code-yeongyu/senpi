import type { AssistantMessage, AssistantMessageEventStream } from "../../../types.ts";
import {
	assistantEvents,
	carryAssistantCapture,
	dropAssistantCapture,
	pushAssistantProgress,
} from "../../../utils/assistant-capture.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../../../utils/event-stream.ts";
import { recoverKimiXtmlThinking } from "./thinking-recovery.ts";

export function wrapStreamWithKimiThinkingRecovery(
	innerStream: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();
	let partial: AssistantMessage | undefined;
	// Ended thinking index -> whether the terminal rewrite inserts a recovered response block after it.
	const splitsByThinkingIndex = new Map<number, boolean>();
	// Blocks that lost a record once lose all later ones, so a block never carries records without its start.
	const droppedIndexes = new Set<number>();
	// Live events keep source indices; only the terminal is rewritten. A record (event capture or control) crosses only
	// while its source index names an existing block that no earlier split can move; otherwise it is dropped, never
	// guessed.
	const keepsIndex = (contentIndex: number): boolean => {
		if (!partial || contentIndex >= partial.content.length) return false;
		if (droppedIndexes.has(contentIndex)) return false;
		for (let index = 0; index < contentIndex; index += 1) {
			if (partial.content[index]?.type === "thinking" && splitsByThinkingIndex.get(index) !== false) {
				droppedIndexes.add(contentIndex);
				return false;
			}
		}
		return true;
	};

	void (async (): Promise<void> => {
		try {
			// Every event but the terminal crosses unchanged: same event objects, same indices, controls in order.
			for await (const event of assistantEvents(innerStream, (progress) => {
				if (keepsIndex(progress.contentIndex)) pushAssistantProgress(outerStream, progress);
			})) {
				if ("partial" in event) partial = event.partial;
				// The same event object crosses, so public bytes stay identical; only its record is withheld.
				if ("contentIndex" in event && !keepsIndex(event.contentIndex)) dropAssistantCapture(event);
				if (event.type === "thinking_end") {
					const alone = { ...event.partial, content: [{ type: "thinking" as const, thinking: event.content }] };
					splitsByThinkingIndex.set(event.contentIndex, recoverKimiXtmlThinking(alone).content.length > 1);
				}
				if (event.type === "done") {
					const message = recoverKimiXtmlThinking(event.message);
					outerStream.push(carryAssistantCapture(event, { type: "done", reason: event.reason, message }, message));
					outerStream.end();
					return;
				}
				if (event.type === "error") {
					outerStream.push(event);
					outerStream.end();
					return;
				}
				outerStream.push(event);
			}
			outerStream.end(recoverKimiXtmlThinking(await innerStream.result()));
		} catch (error) {
			outerStream.fail(error);
		}
	})();

	return outerStream;
}
