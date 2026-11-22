import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type ImageContent,
	type Message,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { FauxModelDefinition } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import lookAtExtension from "../../../src/core/extensions/builtin/look-at/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { createHarness, getToolResult, type Harness } from "../harness.ts";

// senpi#7233: a text-only model that read a screenshot got only "(tool image omitted: model does
// not support images)". Nothing said that look_at could describe the image, and nothing described it.

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const TOOL_NAME = "look_at";
const DESCRIPTION = "A single dark pixel on a transparent background.";
const TEXT_ONLY: FauxModelDefinition = { id: "main", input: ["text"] };
const VISION: FauxModelDefinition = { id: "vision", input: ["text", "image"] };
const harnesses: Harness[] = [];

async function createLookAtHarness(
	models: FauxModelDefinition[],
	extensionFactories: Array<(pi: ExtensionAPI) => void> = [],
): Promise<Harness> {
	const harness = await createHarness({
		models,
		settings: { images: { autoResize: false } },
		extensionFactories: [lookAtExtension, ...extensionFactories],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	await writeFile(join(harness.tempDir, "shot.png"), Buffer.from(PNG, "base64"));
	return harness;
}

function call(toolName: string, args: ToolCall["arguments"] = {}) {
	return fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" });
}

function readShot() {
	return call("read", { path: "shot.png" });
}

function png(): ImageContent {
	return { type: "image", data: PNG, mimeType: "image/png" };
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

	it("puts a description where the tool-result image was, once", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([readShot(), fauxAssistantMessage(DESCRIPTION), fauxAssistantMessage("done")]);
		await harness.session.prompt("read shot.png");
		harness.setResponses([fauxAssistantMessage("still done")]);

		await harness.session.prompt("and again");

		const visionRequests = requestsTo(harness, "vision");
		expect(visionRequests).toHaveLength(1);
		expect(hasImage(lastMessage(visionRequests[0], "user"))).toBe(true);
		const afterTheRead = requestsTo(harness, "main").slice(1);
		expect(afterTheRead).toHaveLength(2);
		for (const request of afterTheRead) {
			const received = lastMessage(request, "toolResult");
			expect(textOf(received)).toContain(DESCRIPTION);
			expect(textOf(received)).toContain(TOOL_NAME);
			expect(textOf(received)).toContain("faux/vision");
			expect(hasImage(received)).toBe(false);
		}
		expect(hasImage(getToolResult(harness, "read"))).toBe(false);
	});

	it("falls back to naming look_at when the description fails", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([
			readShot(),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "vision backend down" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read shot.png");

		expect(requestsTo(harness, "vision")).toHaveLength(1);
		const received = lastMessage(requestsTo(harness, "main").at(-1), "toolResult");
		expect(textOf(received)).toContain(TOOL_NAME);
		expect(textOf(received)).not.toContain("vision backend down");
		expect(hasImage(received)).toBe(false);
		const stored = getToolResult(harness, "read");
		expect(stored.isError).toBe(false);
		expect(hasImage(stored)).toBe(true);
	});

	it("describes at most three images of one tool result", async () => {
		const harness = await createLookAtHarness(
			[TEXT_ONLY, VISION],
			[
				(pi) => {
					pi.registerTool({
						name: "gallery",
						label: "Gallery",
						description: "Returns four images.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [png(), png(), png(), png()], details: undefined }),
					});
				},
			],
		);
		harness.setResponses([
			call("gallery"),
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("show the gallery");

		expect(requestsTo(harness, "vision")).toHaveLength(3);
		const stored = blocksOf(getToolResult(harness, "gallery"));
		expect(stored.map((block) => block.type)).toEqual(["text", "text", "text", "image"]);
		const received = blocksOf(lastMessage(requestsTo(harness, "main").at(-1), "toolResult"));
		expect(received.map((block) => block.type)).toEqual(["text", "text", "text", "text"]);
		expect(received.at(-1)?.text).toContain(TOOL_NAME);
	});

	it("leaves the result of a call another tool made as that tool gets it", async () => {
		let nestedResultHadImage = false;
		const harness = await createLookAtHarness(
			[TEXT_ONLY, VISION],
			[
				(pi) => {
					pi.registerTool({
						name: "relay",
						label: "Relay",
						description: "Reads shot.png through the read tool.",
						parameters: Type.Object({}),
						execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
							const nested = await ctx.executeTool("read", { path: "shot.png" });
							nestedResultHadImage = nested.result.content.some((block) => block.type === "image");
							return { content: nested.result.content, details: undefined };
						},
					});
				},
			],
		);
		harness.setResponses([call("relay"), fauxAssistantMessage(DESCRIPTION), fauxAssistantMessage("done")]);

		await harness.session.prompt("relay the shot");

		expect(nestedResultHadImage).toBe(true);
		expect(requestsTo(harness, "vision")).toHaveLength(1);
		expect(textOf(getToolResult(harness, "relay"))).toContain(DESCRIPTION);
	});

	it("aborts the description request with the turn", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		const started = Promise.withResolvers<{ modelId: string; signal: AbortSignal | undefined }>();
		const released = Promise.withResolvers<void>();
		harness.setResponses([
			readShot(),
			async (_context, options, _state, model) => {
				started.resolve({ modelId: model.id, signal: options?.signal });
				await released.promise;
				return fauxAssistantMessage("late description");
			},
		]);
		const turn = harness.session.prompt("read shot.png");
		const request = await started.promise;
		expect(request.modelId).toBe("vision");
		expect(request.signal?.aborted).toBe(false);

		await harness.session.abort();

		expect(request.signal?.aborted).toBe(true);
		released.resolve();
		await turn;
	});

	it("names look_at where a user-attached image was", async () => {
		const harness = await createLookAtHarness([TEXT_ONLY, VISION]);
		harness.setResponses([fauxAssistantMessage("done")]);
		const attachment = png();

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
