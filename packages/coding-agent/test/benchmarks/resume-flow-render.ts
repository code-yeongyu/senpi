import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import {
	DEFAULT_TAIL_BUDGET,
	DEFAULT_WARM_CHUNK_SIZE,
	ProgressiveTranscriptContainer,
} from "../../src/modes/interactive/components/progressive-transcript-container.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";

export const TRANSCRIPT_WIDTH = 100;

function extractTextContent(message: UserMessage | AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		}
	}
	return parts.join(" ");
}

export function extractRestoredUserAssistantTexts(messages: readonly AgentMessage[]): readonly string[] {
	const texts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
			case "assistant": {
				const text = extractTextContent(message);
				if (text.length > 0) {
					texts.push(text);
				}
				break;
			}
			default:
				break;
		}
	}
	return texts;
}

export function digestRestoredTexts(messages: readonly AgentMessage[]): string {
	const texts = extractRestoredUserAssistantTexts(messages);
	return createHash("sha256").update(texts.join("\n"), "utf8").digest("hex");
}

export function renderTranscript(messages: readonly AgentMessage[]): number {
	const transcript = new ProgressiveTranscriptContainer({
		tailBudget: DEFAULT_TAIL_BUDGET,
		warmChunkSize: DEFAULT_WARM_CHUNK_SIZE,
		requestRender: () => {},
	});
	try {
		for (const message of messages) {
			switch (message.role) {
				case "user": {
					const text = extractTextContent(message);
					if (text.length > 0) transcript.addChild(new UserMessageComponent(text));
					break;
				}
				case "assistant":
					transcript.addChild(new AssistantMessageComponent(message));
					break;
				default:
					break;
			}
		}
		return transcript.render(TRANSCRIPT_WIDTH).length;
	} finally {
		transcript.dispose();
	}
}
