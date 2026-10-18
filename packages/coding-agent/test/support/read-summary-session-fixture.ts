import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { z } from "zod";
import { convertToLlm as harnessConvert } from "../../../agent/src/harness/messages.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { readers } from "./read-summary-fixture.ts";

const entrySchema = z.object({ type: z.string(), message: z.unknown().optional() });
const messageSchema = z.object({ role: z.string(), content: z.unknown().optional() });
const blockSchema = z.object({ type: z.string(), name: z.string().optional(), arguments: z.unknown().optional() });
const resultSchema = z.object({
	role: z.literal("toolResult"),
	toolCallId: z.string(),
	toolName: z.string(),
	timestamp: z.number(),
	isError: z.boolean(),
	content: z.array(
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("text"), text: z.string() }),
			z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
		]),
	),
});

export async function consumeSessionFixture() {
	const file = new URL("../fixtures/before-compaction.jsonl", import.meta.url);
	const bytes = await readFile(file);
	const tools = readers(process.cwd());
	let entries = 0;
	let readCalls = 0;
	let convertedReadResults = 0;
	for (const line of bytes.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		const entry = entrySchema.parse(JSON.parse(line));
		entries++;
		if (entry.type !== "message") continue;
		const message = messageSchema.parse(entry.message);
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const raw of message.content) {
				const block = blockSchema.parse(raw);
				if (block.type !== "toolCall" || block.name !== "read") continue;
				assert(Value.Check(tools.coding.parameters, block.arguments));
				assert(Value.Check(tools.harness.parameters, block.arguments));
				readCalls++;
			}
		}
		if (message.role === "toolResult") {
			const result = resultSchema.parse(entry.message);
			if (result.toolName !== "read") continue;
			// Historical paths are data, never filesystem read targets. Both real conversion contracts keep the result bytes.
			assert.deepEqual(convertToLlm([result]), [result]);
			assert.deepEqual(harnessConvert([result]), [result]);
			convertedReadResults++;
		}
	}
	assert.equal(entries, 1003);
	assert.equal(readCalls, 107);
	assert.equal(convertedReadResults, 104);
	return {
		passed: true,
		fixture: "before-compaction.jsonl",
		sha256: createHash("sha256").update(bytes).digest("hex"),
		entries,
		readCalls,
		convertedReadResults,
		historicalPathsExecuted: false,
	};
}
