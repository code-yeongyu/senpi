import { describe, expect, it } from "vitest";
import {
	getProtocol,
	wrapStreamWithModelRecovery,
	wrapStreamWithToolCallMiddleware,
} from "../../src/tool-call-middleware/index.ts";
import { createXtmlRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/kimi-xtml/recovery-stream.ts";
import { wrapStreamWithKimiThinkingRecovery } from "../../src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery-stream.ts";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import { getAssistantCapture, isAssistantProgress } from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { drainRecords, publicEvents, subscribeCaptureForEachTest } from "../producer-capture-records.ts";
import {
	claudeModel,
	kimiModel,
	nativeCallTurn,
	terminalContent,
	terminalOf,
	tool,
} from "./capture-terminal-fixtures.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

subscribeCaptureForEachTest();

function textTurn(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "stop");
	stream.push({ type: "start", partial: output });
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex: 0, partial: output });
	output.content[0] = { type: "text", text };
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
	stream.push({ type: "done", reason: "stop", message: output });
	stream.end(output);
	return stream;
}

const invokeInProse = 'before <invoke name="Bash"><parameter name="command">echo hi</parameter></invoke> after';

const turns = [
	{ turn: "a native call", source: () => nativeCallTurn("done") },
	{ turn: "plain text", source: () => textTurn("hello") },
	{ turn: "a text call the wrapper recovers", source: () => textTurn(invokeInProse) },
] as const;

const wrappers = [
	{ wrapper: "invoke recovery", wrap: (s: AssistantMessageEventStream) => wrapStreamWithInvokeRecovery(s, [tool]) },
	{
		wrapper: "Kimi XTML invoke recovery",
		wrap: (s: AssistantMessageEventStream) =>
			wrapStreamWithInvokeRecovery(s, [tool], {
				createParser: createXtmlRecoveryStreamParser,
				protocol: "kimi-xtml",
			}),
	},
	{ wrapper: "Kimi thinking recovery", wrap: wrapStreamWithKimiThinkingRecovery },
	{
		wrapper: "model recovery for a Claude id",
		wrap: (s: AssistantMessageEventStream) => wrapStreamWithModelRecovery(s, claudeModel, [tool]),
	},
	{
		wrapper: "model recovery for a Kimi id",
		wrap: (s: AssistantMessageEventStream) => wrapStreamWithModelRecovery(s, kimiModel, [tool]),
	},
	{
		wrapper: "tool-call middleware",
		wrap: (s: AssistantMessageEventStream) => wrapStreamWithToolCallMiddleware(s, getProtocol("antml"), [tool]),
	},
] as const;

const cases = wrappers.flatMap(({ wrapper, wrap }) =>
	turns.map(({ turn, source }) => ({ wrapper, turn, wrap, source })),
);

describe("a completed turn through a recovery wrapper never marks a rewrite #4272", () => {
	it.each(cases)("$wrapper, $turn", async ({ wrap, source }) => {
		const records = await drainRecords(wrap(source()));
		const terminal = terminalOf(publicEvents(records));
		expect(terminal.type).toBe("done");
		expect(terminalContent(terminal).errorMessage).toBeUndefined();
		expect(getAssistantCapture(terminal)).toBeDefined();
		const marked = records.filter(
			(record) => !isAssistantProgress(record) && getAssistantCapture(record)?.rewrittenFrom !== undefined,
		);
		expect(marked).toEqual([]);
	});
});
