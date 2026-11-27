import { describe, expect, it } from "vitest";
import { observeModelWrites } from "../src/written-files/model-writes.ts";
import { holdRead, modelSession, openCell, outcomeFiles } from "./eval/written-files-barriers.ts";
import { reportedPaths, type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

/** Sends one session event to the written-files observers, as the host would. */
function sessionEvents(harness: WrittenFilesHarness) {
	const handlers = new Map<string, (event: unknown) => unknown>();
	observeModelWrites(
		(event, handler) => handlers.set(event, handler),
		() => harness.writtenFiles,
	);
	return async (type: string, event: object) => await handlers.get(type)?.({ type, ...event });
}

// senpi#7232 independent review: what a model call holds is the file it will write, as a scan names that file.
describe("the file a model write or edit call holds (senpi#7232)", () => {
	// Review M3: the hold was taken before the tool_call handlers decided, so a blocked or redirected call took the
	// requested path from a cell that wrote it, and with no later cell that write was never hooked.
	it.each(["blocked", "redirected"] as const)(
		"hooks a cell's own write once when a model write on that path is %s during the cell's read back",
		async (decision) => {
			const harness = writtenFilesHarness();
			const { workspace } = harness;
			const send = sessionEvents(harness);
			const cell = await openCell(harness);
			workspace.write("src/a.ts", "export const a = 1;\n");
			const readBack = holdRead(workspace, "readBack");
			const call = { toolCallId: "call-1", toolName: "write" };

			const settling = cell.settle(new AbortController().signal);
			await readBack.reading;
			await send("tool_execution_start", { ...call, args: { path: "src/a.ts", content: "export {};\n" } });
			if (decision === "redirected")
				await send("tool_call_ready", { ...call, input: { path: "src/elsewhere.ts", content: "export {};\n" } });
			readBack.finish();
			const outcome = outcomeFiles(await settling);
			await send("tool_execution_end", { ...call, isError: decision === "blocked" });
			cell.close();

			expect({ outcome, hooked: reportedPaths(harness) }).toEqual({
				outcome: { files: ["src/a.ts"], total: 1, hooked: 1 },
				hooked: [workspace.absolute("src/a.ts")],
			});
		},
	);

	// Review M4: the hold was keyed by the spelling the model typed, a scan by the spelling on disk.
	it("holds the file under its on-disk spelling when the model names it in another case on a case-insensitive filesystem", async () => {
		const harness = writtenFilesHarness();
		const { workspace } = harness;
		workspace.caseInsensitive = true;
		workspace.write("src/app.ts", "export const app = 1;\n");
		workspace.commit();
		const model = modelSession(harness);
		const watching = await openCell(harness);

		await model.start("call-1", "write", "SRC/APP.ts");
		workspace.write("SRC/APP.ts", "export const app = 2;\n");
		const whileHeld = await watching.settle(new AbortController().signal);
		await model.end("call-1");
		const afterEnd = await watching.settle(new AbortController().signal);
		workspace.write("src/app.ts", "export const app = 3;\n");
		const laterChange = outcomeFiles(await watching.settle(new AbortController().signal));
		watching.close();

		expect({ whileHeld, afterEnd, laterChange, hooked: reportedPaths(harness) }).toEqual({
			whileHeld: undefined,
			afterEnd: undefined,
			laterChange: { files: ["src/app.ts"], total: 1, hooked: 1 },
			hooked: [workspace.absolute("src/app.ts")],
		});
	});
});
