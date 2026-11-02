import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, ProviderNativeContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import openaiImageGenExtension from "../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { formatProviderNativeBody, formatProviderNativeSummary } from "../../src/modes/provider-native-rendering.ts";
import { createHarness, type Harness } from "./harness.ts";

/** 1x1 PNG. The first 32 characters double as the leak sentinel. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl3T2QAAAAASUVORK5CYII=";
const BASE64_SENTINEL = PNG_BASE64.slice(0, 32);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface NativeImageItem {
	type: "image_generation_call";
	id?: string;
	status: string;
	result?: string;
	revised_prompt?: string;
}

function nativeImageBlock(item: NativeImageItem): ProviderNativeContent {
	return { type: "providerNative", subtype: "image_generation_call", raw: item };
}

const harnesses: Harness[] = [];

async function startSession(): Promise<Harness> {
	const harness = await createHarness({
		persistSession: true,
		extensionFactories: [openaiImageGenExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return harness;
}

function assistantMessages(harness: Harness): AssistantMessage[] {
	return harness.session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function assistantTexts(harness: Harness): string[] {
	return assistantMessages(harness).flatMap((message) =>
		message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
	);
}

function providerNativeBlocks(harness: Harness): ProviderNativeContent[] {
	return assistantMessages(harness).flatMap((message) =>
		message.content.flatMap((block) => (block.type === "providerNative" ? [block] : [])),
	);
}

function serializedSession(harness: Harness): string {
	const sessionFile = harness.session.sessionFile;
	if (sessionFile === undefined) throw new Error("session was not persisted");
	return readFileSync(sessionFile, "utf8");
}

describe("openai-image-gen message_end externalization", () => {
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a completed native image call #when the message ends #then the base64 becomes a saved path", async () => {
		const harness = await startSession();
		harness.setResponses([
			fauxAssistantMessage([
				nativeImageBlock({
					type: "image_generation_call",
					id: "ig_fixture_1",
					status: "completed",
					result: PNG_BASE64,
					revised_prompt: "a red fox in snow",
				}),
			]),
		]);

		await harness.session.prompt("draw a fox");

		const texts = assistantTexts(harness);
		expect(texts.join("\n")).toContain("Generated image: generated-images/ig_fixture_1.png");
		expect(texts.join("\n")).toContain("Revised prompt: a red fox in snow");
		expect(providerNativeBlocks(harness)).toHaveLength(0);

		const saved = readFileSync(join(harness.tempDir, "generated-images", "ig_fixture_1.png"));
		expect(saved.subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(serializedSession(harness)).not.toContain(BASE64_SENTINEL);
	});

	it("#given no item id #when the message ends #then the response id and output index name the file", async () => {
		const harness = await startSession();
		harness.setResponses([
			fauxAssistantMessage(
				[nativeImageBlock({ type: "image_generation_call", status: "completed", result: PNG_BASE64 })],
				{ responseId: "resp_42" },
			),
		]);

		await harness.session.prompt("draw a fox");

		expect(assistantTexts(harness).join("\n")).toContain("Generated image: generated-images/resp_42-0.png");
		const saved = readFileSync(join(harness.tempDir, "generated-images", "resp_42-0.png"));
		expect(saved.subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(serializedSession(harness)).not.toContain(BASE64_SENTINEL);
	});

	it("#given a duplicate item id #when both images arrive #then the second is suffixed and both survive", async () => {
		const harness = await startSession();
		harness.setResponses([
			fauxAssistantMessage([
				nativeImageBlock({ type: "image_generation_call", id: "ig_dup", status: "completed", result: PNG_BASE64 }),
				nativeImageBlock({ type: "image_generation_call", id: "ig_dup", status: "completed", result: PNG_BASE64 }),
			]),
		]);

		await harness.session.prompt("draw two foxes");

		const text = assistantTexts(harness).join("\n");
		expect(text).toContain("Generated image: generated-images/ig_dup.png");
		expect(text).toContain("Generated image: generated-images/ig_dup-2.png");
		expect(readFileSync(join(harness.tempDir, "generated-images", "ig_dup.png")).subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(readFileSync(join(harness.tempDir, "generated-images", "ig_dup-2.png")).subarray(0, 8)).toEqual(PNG_MAGIC);
		expect(serializedSession(harness)).not.toContain(BASE64_SENTINEL);
	});

	it("#given the destination cannot be written #when the message ends #then failure text replaces the base64", async () => {
		const harness = await startSession();
		// A regular file where the directory belongs makes mkdir fail with ENOTDIR.
		writeFileSync(join(harness.tempDir, "generated-images"), "blocker");
		harness.setResponses([
			fauxAssistantMessage([
				nativeImageBlock({ type: "image_generation_call", id: "ig_fail", status: "completed", result: PNG_BASE64 }),
			]),
		]);

		await harness.session.prompt("draw a fox");

		const text = assistantTexts(harness).join("\n");
		expect(text).toContain("could not be saved");
		expect(text).not.toContain(BASE64_SENTINEL);
		expect(providerNativeBlocks(harness)).toHaveLength(0);
		expect(serializedSession(harness)).not.toContain(BASE64_SENTINEL);
	});

	it("#given a non-completed native image call #when the message ends #then the status block is left alone", async () => {
		const harness = await startSession();
		harness.setResponses([
			fauxAssistantMessage([nativeImageBlock({ type: "image_generation_call", id: "ig_failed", status: "failed" })]),
		]);

		await harness.session.prompt("draw a fox");

		expect(providerNativeBlocks(harness)).toHaveLength(1);
		expect(assistantTexts(harness).join("\n")).not.toContain("Generated image:");
	});
});

describe("image_generation_call provider-native rendering", () => {
	const message: AssistantMessage = fauxAssistantMessage("");

	it("#given a completed call #when it renders #then status and byte count show without the result", () => {
		const content = nativeImageBlock({
			type: "image_generation_call",
			id: "ig_render",
			status: "completed",
			result: PNG_BASE64,
			revised_prompt: "a red fox in snow",
		});

		const summary = formatProviderNativeSummary(message, content, false);
		const body = formatProviderNativeBody(content, true);

		expect(summary).toContain("image_generation");
		expect(body).toContain("status: completed");
		expect(body).toContain("68 bytes");
		expect(body).toContain("revised prompt: a red fox in snow");
		expect(body).not.toContain(BASE64_SENTINEL);
		expect(body).not.toContain("generated-images");
	});

	it("#given a failed call #when it renders #then only the status shows", () => {
		const content = nativeImageBlock({ type: "image_generation_call", id: "ig_render", status: "failed" });

		const body = formatProviderNativeBody(content, true);

		expect(body).toBe("status: failed");
	});
});
