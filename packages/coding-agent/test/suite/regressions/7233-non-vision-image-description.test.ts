import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type Message,
} from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import lookAtExtension from "../../../src/core/extensions/builtin/look-at/index.ts";
import { createHarness, getToolResult, type Harness } from "../harness.ts";

// senpi#7233: a text-only model that read a screenshot got only "(tool image omitted: model does
// not support images)". Nothing said that look_at could describe the image.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "look_at";
const TEXT_ONLY: FauxModelDefinition = { id: "main", input: ["text"] };
const VISION: FauxModelDefinition = { id: "vision", input: ["text", "image"] };
const harnesses: Harness[] = [];

async function createLookAtHarness(models: FauxModelDefinition[]): Promise<Harness> {
	const harness = await createHarness({
		models,
		settings: { images: { autoResize: false } },
		extensionFactories: [lookAtExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	await writeFile(join(harness.tempDir, "shot.png"), Buffer.from(PNG, "base64"));
	return harness;
}

function readShot() {
	return fauxAssistantMessage(fauxToolCall("read", { path: "shot.png" }), { stopReason: "toolUse" });
}

function requestsTo(harness: Harness, modelId: string): Context[] {
	return harness.faux
		.getCallLog()
		.filter((call) => call.modelId === modelId)
		.map((call) => call.context);
}

function lastMessage(context: Context | undefined, role: Message["role"]): Message {
	const message = context?.messages.findLast((candidate) => candidate.role === role);
	if (!message) throw new Error(`The request carried no ${role} message.`);
	return message;
}

function blocksOf(message: Message): Array<{ type: string; text?: string }> {
	if (!Array.isArray(message.content)) throw new Error("Expected structured content.");
	return message.content;
}

function textOf(message: Message): string {
	return blocksOf(message)
		.map((block) => block.text ?? "")
		.join("\n");
}

function hasImage(message: Message): boolean {
	return blocksOf(message).some((block) => block.type === "image");
}

describe("images a text-only model cannot see (senpi#7233)", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("names look_at where a tool-result image was", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([readShot(), fauxAssistantMessage("done")]);

		await harness.session.prompt("read shot.png");

		const received = lastMessage(requestsTo(harness, "main").at(-1), "toolResult");
		expect(textOf(received)).toContain(TOOL_NAME);
		expect(hasImage(received)).toBe(false);
		const stored = getToolResult(harness, "read");
		expect(stored.isError).toBe(false);
		expect(hasImage(stored)).toBe(true);
	});

	it("names look_at where a user-attached image was", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([fauxAssistantMessage("done")]);
		const attachment: ImageContent = { type: "image", data: PNG, mimeType: "image/png" };

		await harness.session.prompt("what is this", { images: [attachment] });

		const received = lastMessage(requestsTo(harness, "main").at(-1), "user");
		expect(textOf(received)).toContain(TOOL_NAME);
		expect(hasImage(received)).toBe(false);
	});

	it("names no tool when the model has none to call", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY]);
		harness.setResponses([readShot(), fauxAssistantMessage("done")]);

		await harness.session.prompt("read shot.png");

		expect(harness.session.getActiveToolNames()).not.toContain(TOOL_NAME);
		const received = lastMessage(requestsTo(harness, "main").at(-1), "toolResult");
		expect(hasImage(received)).toBe(true);
		expect(textOf(received)).not.toContain(TOOL_NAME);
	});

	it("passes the image through to a model with image input", async () => {
		const harness = await createLookAtHarness([VISION]);
		harness.setResponses([readShot(), fauxAssistantMessage("done")]);

		await harness.session.prompt("read shot.png");

		const requests = requestsTo(harness, "vision");
		expect(requests).toHaveLength(2);
		expect(hasImage(lastMessage(requests.at(-1), "toolResult"))).toBe(true);
	});
});
