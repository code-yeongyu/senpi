import { describe, expect, it } from "vitest";
import { lazyStream } from "../../src/api/lazy.ts";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import {
	type AssistantRecord,
	assistantRecords,
	carryAssistantCapture,
	getAssistantCapture,
	isAssistantProgress,
} from "../../src/utils/assistant-capture.ts";
import {
	drainRecords,
	publicEvents,
	recordsOnForeignBlocks,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import {
	carryingRecords,
	claudeModel,
	type Ending,
	nativeCallTurn,
	type Terminal,
	terminalContent,
	terminalOf,
	tool,
} from "./capture-terminal-fixtures.ts";

subscribeCaptureForEachTest();

/** The reader rule a terminal's `rewrittenFrom` sets: records for that index and above are dropped. */
function keptByReader(records: AssistantRecord[], rewrittenFrom: number | undefined): AssistantRecord[] {
	return carryingRecords(records).filter((record) => {
		if (rewrittenFrom === undefined || !("contentIndex" in record)) return true;
		const index = isAssistantProgress(record)
			? record.contentIndex
			: (getAssistantCapture(record)?.contentIndex ?? record.contentIndex);
		return index < rewrittenFrom;
	});
}

interface Rewrite {
	readonly seen: AssistantRecord[];
	readonly terminal: Terminal;
}

async function ended(ending: Ending): Promise<Rewrite> {
	const records = await drainRecords(wrapStreamWithInvokeRecovery(nativeCallTurn(ending), [tool]));
	return { seen: records, terminal: terminalOf(publicEvents(records)) };
}

/** The consumer stops after the text starts; the cancellation terminal is read afterwards. */
async function cancelledAfterTextStart(): Promise<Rewrite> {
	const wrapped = wrapStreamWithInvokeRecovery(nativeCallTurn("done"), [tool]);
	const iterator = assistantRecords(wrapped)[Symbol.asyncIterator]();
	const seen: AssistantRecord[] = [];
	for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
		seen.push(next.value);
		if (next.value.type === "text_start") break;
	}
	await iterator.return?.();
	const rest: AssistantRecord[] = [];
	for await (const record of assistantRecords(wrapped)) rest.push(record);
	return { seen, terminal: terminalOf(publicEvents(rest)) };
}

function outcome(terminal: Terminal): string {
	const content = terminalContent(terminal);
	return `${terminal.type}:${terminal.reason}:${content.errorMessage ?? ""}`;
}

// One row per terminal kind that removes tool calls. Each drops the call at outer 1, so the text at 2 moves to 1 and
// index 2 names nothing; the forwarded fallback abort carries source indices, so no index of it is provable.
const toolRemovingTerminals = [
	{ kind: "aborted source", run: () => ended("aborted"), outcome: "error:aborted:Request was aborted", from: 1 },
	{
		kind: "cancelled consumer",
		run: cancelledAfterTextStart,
		outcome: "error:error:Assistant message stream consumption was cancelled",
		from: 1,
	},
	{ kind: "superseded by a fallback receipt", run: () => ended("superseded"), outcome: "done:toolUse:", from: 1 },
	{
		kind: "superseded by a fallback receipt on a source error",
		run: () => ended("superseded-error"),
		outcome: "error:error:",
		from: 1,
	},
	{
		kind: "invalid content event order",
		run: () => ended("invalid-content-order"),
		outcome: "error:error:Invalid assistant content event order",
		from: 1,
	},
	{
		kind: "invalid native event order",
		run: () => ended("invalid-native-order"),
		outcome: "error:error:Invalid native tool call event order",
		from: 1,
	},
	{
		kind: "tool call id collision",
		run: () => ended("collision"),
		outcome: "error:error:Tool call ID collision in provider stream",
		from: 1,
	},
	{ kind: "forwarded fallback abort", run: () => ended("fallback-aborted"), outcome: "error:error:", from: 0 },
] as const;

describe("recovery terminals that rewrite content mark the records they invalidate #4272", () => {
	it("marks nothing when the terminal keeps every block at its index", async () => {
		const { seen, terminal } = await ended("done");
		expect(terminalContent(terminal).content.map((block) => block.type)).toEqual(["thinking", "toolCall", "text"]);
		expect(getAssistantCapture(terminal)?.rewrittenFrom).toBeUndefined();
		expect(recordsOnForeignBlocks(carryingRecords(seen), terminalContent(terminal))).toEqual([]);
	});

	it.each(toolRemovingTerminals)(
		"a $kind terminal marks rewrittenFrom $from",
		async ({ run, outcome: kind, from }) => {
			const { seen, terminal } = await run();
			const content = terminalContent(terminal);
			expect(outcome(terminal)).toBe(kind);
			expect(content.content.some((block) => block.type === "toolCall")).toBe(false);
			expect(recordsOnForeignBlocks(carryingRecords(seen), content)).not.toEqual([]);
			expect(getAssistantCapture(terminal)?.rewrittenFrom).toBe(from);
			expect(recordsOnForeignBlocks(keptByReader(seen, from), content)).toEqual([]);
		},
	);

	it("keeps the mark when a later wrapper or the agent re-carries the terminal onto its own message", async () => {
		const { terminal } = await ended("aborted");
		const message = terminalContent(terminal);
		const carried = carryAssistantCapture(terminal, { type: "message_end", message }, message);
		expect(getAssistantCapture(carried)?.rewrittenFrom).toBe(1);
	});

	it("keeps the mark across the lazy stream forwarder", async () => {
		const lazy = lazyStream(claudeModel, async () => wrapStreamWithInvokeRecovery(nativeCallTurn("aborted"), [tool]));
		const terminal = terminalOf(publicEvents(await drainRecords(lazy)));
		expect(getAssistantCapture(terminal)?.rewrittenFrom).toBe(1);
	});
});
