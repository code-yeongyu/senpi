import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../../src/core/extensions/builtin/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * code-yeongyu/oh-my-openagent#10579: tool text must reach the provider byte-for-byte, vendor and model names
 * included, or a read -> write round trip changes files. Drives the real tools with every builtin extension
 * loaded; the write content is the exact read result the provider received.
 */

const NAMES = ["Claude Sonnet", "Claude Code", "Claude", "GPT-5", "Mistral", "OpenAI", "Anthropic"];
const SOURCE = `${NAMES.map((name, index) => `L${index}=${name}`).join("\n")}\nC=plain\n`;
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function toolResultTexts(context: TranscriptContext): string[] {
	return context.messages.flatMap((message) =>
		message.role === "toolResult"
			? [message.content.map((part) => (part.type === "text" ? part.text : "")).join("")]
			: [],
	);
}

describe("tool text reaches the model unchanged (omo#10579)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("round-trips a file naming vendors through read and write, and bash and grep show the names", async () => {
		const harness = await createHarness({
			extensionFactories: builtinExtensions.map((entry) => entry.factory),
			initialActiveToolNames: ["read", "write", "bash", "grep"],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const source = join(harness.tempDir, "src.txt");
		const copy = join(harness.tempDir, "copy.txt");
		writeFileSync(source, SOURCE);

		const seen: string[][] = [];
		const step =
			(next: (texts: string[]) => AssistantMessage) =>
			(context: TranscriptContext): AssistantMessage => {
				const texts = toolResultTexts(context);
				seen.push(texts);
				return next(texts);
			};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: source })], { stopReason: "toolUse" }),
			step((texts) =>
				fauxAssistantMessage([fauxToolCall("write", { path: copy, content: texts.at(-1) ?? "" })], {
					stopReason: "toolUse",
				}),
			),
			step(() =>
				fauxAssistantMessage([fauxToolCall("bash", { command: "cat src.txt" })], { stopReason: "toolUse" }),
			),
			step(() =>
				fauxAssistantMessage(
					[fauxToolCall("grep", { pattern: "Claude|OpenAI|Mistral|Anthropic|GPT-5", path: "." })],
					{
						stopReason: "toolUse",
					},
				),
			),
			step(() => fauxAssistantMessage("done")),
		]);

		await harness.session.prompt("copy src.txt to copy.txt");

		expect(sha256(readFileSync(copy))).toBe(sha256(SOURCE));
		const final = seen.at(-1) ?? [];
		const [read, , bash, grep] = final;
		expect(read).toBe(SOURCE);
		for (const text of [bash, grep]) {
			for (const name of NAMES) expect(text).toContain(name);
		}
		expect(final.join("\n")).not.toMatch(/\[(OI|CC)\]/);
	});
});
