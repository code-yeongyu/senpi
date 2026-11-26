import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { RecoveryAssistantMessageEventStream } from "../../src/tool-call-middleware/recovery-event-stream.ts";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import type { AssistantMessageEvent, ThinkingContent, ToolCall } from "../../src/types.ts";
import { getAssistantCapture, pushAssistantProgress } from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	drainRecords,
	firstEvent,
	publicEvents,
	recordKinds,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

subscribeCaptureForEachTest();

const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };

/** One copied block at 0 whose control the source emits before the block's start event. */
function controlBeforeStart(kind: "toolCall" | "thinking"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	stream.push({ type: "start", partial: output });
	if (kind === "toolCall") {
		const call: ToolCall = { type: "toolCall", id: "native", name: "Bash", arguments: {} };
		output.content.push(call);
		pushAssistantProgress(stream, {
			type: "message_tool_arguments_reset",
			contentIndex: 0,
			rawArgumentPrefix: "",
			parsedThrough: 0,
		});
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
	} else {
		const thinking: ThinkingContent = { type: "thinking", thinking: "plan" };
		output.content.push(thinking);
		pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "s" });
		stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
		stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	}
	output.stopReason = kind === "toolCall" ? "toolUse" : "stop";
	stream.push({ type: "done", reason: output.stopReason === "toolUse" ? "toolUse" : "stop", message: output });
	stream.end(output);
	return stream;
}

describe("recovery copies keep a block's records in one order #4272", () => {
	it.each([
		["toolCall", ["start", "toolcall_start:0", "message_tool_arguments_reset:0", "toolcall_end:0", "done"]],
		["thinking", ["start", "thinking_start:0", "message_block_metadata:0", "thinking_end:0", "done"]],
	] as const)("relays a %s control held for its block after that block's start", async (kind, order) => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(controlBeforeStart(kind), [tool]));
		expect(recordKinds(records)).toEqual(order);
	});

	it("relays the source's record to one copy only when a step pushes two events of its type", async () => {
		const source = new AssistantMessageEventStream({ captureBlocks: true });
		const sourceMessage = createAssistantMessage([{ type: "thinking", thinking: "" }], "pending");
		source.push({ type: "start", partial: sourceMessage });
		const sourceStart: AssistantMessageEvent = { type: "thinking_start", contentIndex: 0, partial: sourceMessage };
		source.push(sourceStart);
		const outer = new RecoveryAssistantMessageEventStream();
		const outerMessage = createAssistantMessage(
			[
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "other" },
			],
			"pending",
		);
		outer.push({ type: "start", partial: outerMessage });
		outer.relaying(sourceStart, () => {
			outer.push({ type: "thinking_start", contentIndex: 0, partial: outerMessage });
			outer.push({ type: "thinking_start", contentIndex: 1, partial: outerMessage });
		});
		outer.end(outerMessage);
		const events = publicEvents(await drainRecords(outer));
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 0))?.block).toEqual({
			type: "thinking",
			thinking: "",
		});
		// The second push is no copy of the source, and its own block was read late: no record, never the source's.
		expect(getAssistantCapture(firstEvent(events, "thinking_start", 1))).toBeUndefined();
	});
});
