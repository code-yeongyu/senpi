import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import {
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	pushAssistantProgress,
	subscribeAssistantCapture,
} from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
const invoke =
	'<antml:invoke name="Bash"><antml:parameter name="command">echo recovered</antml:parameter></antml:invoke>';

let releaseCapture = () => {};
beforeEach(() => {
	releaseCapture = subscribeAssistantCapture();
});
afterEach(() => releaseCapture());

describe("unaware recovery capture boundary #4272", () => {
	it("drops carriers and all controls when recovery remaps a native call", async () => {
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const output = createAssistantMessage([], "pending");
		source.push({ type: "start", partial: output });
		output.content.push({ type: "text", text: "" });
		source.push({ type: "text_start", contentIndex: 0, partial: output });
		const text = `before ${invoke} after`;
		output.content[0] = { type: "text", text };
		source.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
		source.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
		const call = { type: "toolCall" as const, id: "native", name: "Bash", arguments: { command: "echo native" } };
		output.content.push(call);
		const start = { type: "toolcall_start" as const, contentIndex: 1, partial: output };
		source.push(start);
		pushAssistantProgress(source, { type: "message_block_state", contentIndex: 1, phase: "insert", block: call });
		source.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
		output.stopReason = "toolUse";
		source.push({ type: "done", reason: "toolUse", message: output });
		expect(getAssistantCapture(start)?.block).toEqual(call);

		const wrapped = wrapStreamWithInvokeRecovery(source, [tool]);
		const records = [];
		for await (const record of assistantRecords(wrapped)) records.push(record);
		expect(records.filter(isAssistantProgress)).toEqual([]);
		expect(records.map(getAssistantCapture).every((capture) => capture === undefined)).toBe(true);
		const nativeStart = records.find((record) => {
			if (record.type !== "toolcall_start") return false;
			const block = record.partial.content[record.contentIndex];
			return block?.type === "toolCall" && block.id === "native";
		});
		expect(nativeStart).toMatchObject({ type: "toolcall_start", contentIndex: 3 });
		expect(getAssistantCapture(start)).toBeUndefined();
	});
});
