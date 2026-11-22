import { describe, expect, it } from "vitest";
import { observeModelWrites } from "../src/written-files/model-writes.ts";
import { openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

const signal = new AbortController().signal;

/** A session whose model-write events a test sends by hand, in the order the host would. */
function session(harness: WrittenFilesHarness) {
	const handlers = new Map<string, (event: unknown) => unknown>();
	observeModelWrites(
		(event, handler) => handlers.set(event, handler),
		() => harness.writtenFiles,
	);
	const send = async (type: string, event: object = {}) => await handlers.get(type)?.({ type, ...event });
	return {
		start: (toolCallId: string, toolName: string, path: string) =>
			send("tool_execution_start", { toolCallId, toolName, args: { path } }),
		end: (toolCallId: string, isError = false) => send("tool_execution_end", { toolCallId, isError }),
		turnStart: () => send("turn_start"),
	};
}

// senpi#7232, seventh review: a model write or edit holds its file from its start until its end, and never longer.
describe("a model write's hold on its file", () => {
	it("holds a file two model calls write until both end, and records the state they left", async () => {
		const harness = writtenFilesHarness();
		const model = session(harness);
		const cell = await openCell(harness);

		await model.start("write-1", "write", "src/a.ts");
		await model.start("edit-1", "edit", "src/a.ts");
		harness.workspace.write("src/a.ts", "export const a = 1;\n");
		const whileBothRun = await cell.settle(signal);
		await model.end("write-1");
		harness.workspace.write("src/a.ts", "export const a = 2;\n");
		const whileEditRuns = await cell.settle(signal);
		await model.end("edit-1");
		const afterBoth = await cell.settle(signal);
		harness.workspace.write("src/a.ts", "export const a = 3;\n");
		const laterChange = outcomeFiles(await cell.settle(signal));
		cell.close();

		expect({ whileBothRun, whileEditRuns, afterBoth, laterChange }).toEqual({
			whileBothRun: undefined,
			whileEditRuns: undefined,
			afterBoth: undefined,
			laterChange: { files: ["src/a.ts"], total: 1, hooked: 1 },
		});
	});

	it("lets go of a failed call's file without recording it, so a cell reports what is on disk", async () => {
		const harness = writtenFilesHarness();
		const model = session(harness);
		const cell = await openCell(harness);

		await model.start("write-1", "write", "src/a.ts");
		harness.workspace.write("src/a.ts", "export const a = 1;\n");
		await model.end("write-1", true);
		const outcome = outcomeFiles(await cell.settle(signal));
		cell.close();

		expect(outcome).toEqual({ files: ["src/a.ts"], total: 1, hooked: 1 });
	});

	it("lets go of a call whose end never arrives when the next turn starts", async () => {
		const harness = writtenFilesHarness();
		const model = session(harness);
		const cell = await openCell(harness);

		await model.start("write-1", "write", "src/a.ts");
		harness.workspace.write("src/a.ts", "export const a = 1;\n");
		const whileHeld = await cell.settle(signal);
		await model.turnStart();
		const afterTurn = outcomeFiles(await cell.settle(signal));
		await model.end("write-1");
		cell.close();

		expect({ whileHeld, afterTurn }).toEqual({
			whileHeld: undefined,
			afterTurn: { files: ["src/a.ts"], total: 1, hooked: 1 },
		});
	});

	it("holds nothing for a call that names no file in the workspace or is not a write or edit", () => {
		const { writtenFiles } = writtenFilesHarness();

		expect([
			writtenFiles.startToolCall("write", { path: "../outside.ts" }),
			writtenFiles.startToolCall("write", { content: "export {};\n" }),
			writtenFiles.startToolCall("read", { path: "src/a.ts" }),
		]).toEqual([undefined, undefined, undefined]);
	});
});
