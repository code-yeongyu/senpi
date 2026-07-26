import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const TRANSPORT_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

function image(data: string) {
	return { type: "image", data, mimeType: "image/png" } as const;
}

type ContentMessage = AgentMessage & {
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

function hasContent(message: AgentMessage): message is ContentMessage {
	return "content" in message;
}

function inlineImageChars(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (
			!hasContent(message) ||
			!(message.role === "user" || message.role === "toolResult") ||
			!Array.isArray(message.content)
		) {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "image") total += block.data?.length ?? 0;
		}
	}
	return total;
}

function findSeededMessage(messages: AgentMessage[]): ContentMessage | undefined {
	return messages.find(
		(message): message is ContentMessage =>
			hasContent(message) &&
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some(
				(block) => block.type === "text" && block.text === "Keep this text and the latest images.",
			),
	);
}

describe("issue #302: transport image budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps accumulated image requests within the provider-safe transport budget without mutating the session", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const seededMessage: Message = {
			role: "user",
			content: [
				{ type: "text", text: "Keep this text and the latest images." },
				image("A".repeat(9 * 1024 * 1024)),
				image("B".repeat(9 * 1024 * 1024)),
				image("C".repeat(9 * 1024 * 1024)),
			],
			timestamp: 1,
		};
		harness.sessionManager.appendMessage(seededMessage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("first response"), fauxAssistantMessage("second response")]);

		await harness.session.prompt("continue");
		await harness.session.prompt("continue again");

		const callLog = harness.faux.getCallLog();
		expect(callLog).toHaveLength(2);
		for (const call of callLog) {
			expect(inlineImageChars(call.context.messages)).toBeLessThanOrEqual(TRANSPORT_IMAGE_BUDGET_BYTES);
		}

		const persisted = findSeededMessage(harness.sessionManager.buildSessionContext().messages);
		expect(persisted?.content).toEqual(seededMessage.content);
	});
});
