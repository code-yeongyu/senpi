import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_ELISION_PLACEHOLDER } from "../src/core/messages.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function image(data: string) {
	return { type: "image", data, mimeType: "image/png" } as const;
}

type ContentMessage = AgentMessage & {
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

function hasContent(message: AgentMessage): message is ContentMessage {
	return "content" in message;
}

function findSeededMessage(messages: AgentMessage[]): ContentMessage | undefined {
	return messages.find(
		(message): message is ContentMessage =>
			hasContent(message) &&
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "text" && block.text === "seed-note"),
	);
}

function countImages(messages: AgentMessage[]): number {
	let count = 0;
	for (const message of messages) {
		if (!hasContent(message) || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") count++;
		}
	}
	return count;
}

describe("transport image budget (main loop)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("elides old images from the first request when over budget", async () => {
		const harness = await createHarness({
			transportImageBudget: { budgetBytes: 100, alwaysKeepNewest: 1 },
		});
		harnesses.push(harness);
		const seededMessage: Message = {
			role: "user",
			content: [
				{ type: "text", text: "seed-note" },
				image("A".repeat(60)),
				image("B".repeat(60)),
				image("C".repeat(60)),
			],
			timestamp: 1,
		};
		harness.sessionManager.appendMessage(seededMessage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("continue");

		const callLog = harness.faux.getCallLog();
		expect(callLog).toHaveLength(1);
		expect(countImages(callLog[0].context.messages)).toBe(1);
		const transported = findSeededMessage(callLog[0].context.messages);
		expect(transported?.content).toEqual([
			{ type: "text", text: "seed-note" },
			{ type: "text", text: IMAGE_ELISION_PLACEHOLDER },
			image("C".repeat(60)),
		]);

		const persisted = findSeededMessage(harness.sessionManager.buildSessionContext().messages);
		expect(persisted?.content).toEqual(seededMessage.content);
	});

	it("does not touch requests under the budget", async () => {
		const harness = await createHarness({
			transportImageBudget: { budgetBytes: 100, alwaysKeepNewest: 1 },
		});
		harnesses.push(harness);
		const seededMessage: Message = {
			role: "user",
			content: [{ type: "text", text: "seed-note" }, image("A".repeat(10)), image("B".repeat(10))],
			timestamp: 1,
		};
		harness.sessionManager.appendMessage(seededMessage);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("continue");

		const callLog = harness.faux.getCallLog();
		expect(callLog).toHaveLength(1);
		expect(countImages(callLog[0].context.messages)).toBe(2);
		expect(findSeededMessage(callLog[0].context.messages)?.content).toEqual(seededMessage.content);
		expect(JSON.stringify(callLog[0].context.messages)).not.toContain(IMAGE_ELISION_PLACEHOLDER);
	});
});
