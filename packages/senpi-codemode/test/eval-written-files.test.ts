import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { createExecuteTool } from "../src/extension/runtime-factory.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { EvalKernelRunInput, EvalToolDetails, ExecuteTool } from "../src/tool/types.ts";
import { WRITTEN_FILES_LIMIT } from "../src/written-files/write-hooks.ts";
import { FakeKernel, FakeManager, result } from "./eval/fakes.ts";
import { type WrittenFilesHarness, writtenFilesHarness } from "./eval/written-files-fakes.ts";

/** A kernel whose cell does its work, such as writing files with plain fs, before it reports its result. */
class WorkingKernel extends FakeKernel {
	readonly #work: () => void;

	constructor(messages: KernelToHostMessage[], work: () => void) {
		super(messages);
		this.#work = work;
	}

	override async run(input: EvalKernelRunInput) {
		this.#work();
		return await super.run(input);
	}
}

const unusedTool: ExecuteTool = async () => ({ content: [{ type: "text", text: "unused" }], details: {} });

async function runCell(
	harness: WrittenFilesHarness,
	kernel: FakeKernel,
	cellId: string,
	executeTool: ExecuteTool = unusedTool,
): Promise<AgentToolResult<EvalToolDetails>> {
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool,
		writtenFiles: harness.writtenFiles,
	});
	return await tool.execute(
		cellId,
		{ language: "js", code: "work()", summary: "written files" },
		undefined,
		undefined,
		harness.ctx,
	);
}

function texts(cell: AgentToolResult<EvalToolDetails>): string[] {
	return cell.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

// senpi#7232: files an eval cell writes on its own skipped every hook a write call triggers.
describe("files an eval cell writes without a write call (senpi#7232)", () => {
	it("sends the file through the write hooks and returns what they appended with the file list", async () => {
		const diagnostic = "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.";
		const harness = writtenFilesHarness(async (report) => ({
			toolCallId: "cell/reported-1",
			result: { content: [...report.content, { type: "text", text: diagnostic }] },
			failures: [],
		}));
		const source = "export const a: number = 'x';\n";
		const kernel = new WorkingKernel([result("plain-fs", "undefined")], () =>
			harness.workspace.write("src/a.ts", source),
		);

		const cell = await runCell(harness, kernel, "plain-fs");

		expect(harness.reported).toEqual([
			{
				toolName: "write",
				input: { path: harness.workspace.absolute("src/a.ts"), content: source },
				content: [{ type: "text", text: `Successfully wrote to ${harness.workspace.absolute("src/a.ts")}` }],
			},
		]);
		expect(cell.details.writtenFiles).toEqual({ files: ["src/a.ts"], total: 1, hooked: 1 });
		expect(texts(cell).some((text) => text.includes(diagnostic))).toBe(true);
		expect(cell.details.isError).toBeUndefined();
	});

	it("returns no list for a cell that writes no source file, whatever was written before it started", async () => {
		const harness = writtenFilesHarness();
		harness.workspace.write("src/committed.ts", "export {};\n");
		harness.workspace.commit();
		harness.workspace.write("src/before.ts", "written by an earlier tool call\n");
		harness.workspace.write("data.bin", new Uint8Array([0, 159, 146, 150]));

		const cell = await runCell(harness, new FakeKernel([result("print-only", "42")]), "print-only");

		expect(cell.details.writtenFiles).toBeUndefined();
		expect(texts(cell)).toHaveLength(1);
		expect(harness.reported).toEqual([]);
	});

	it("does not send a file through the hooks again after a nested write call took it there", async () => {
		const harness = writtenFilesHarness();
		let pipelineHookRuns = 0;
		const executeTool = createExecuteTool(
			{
				executeTool: async (_toolName, params) => {
					const path = String(Reflect.get(Object(params), "path"));
					harness.workspace.write(path, String(Reflect.get(Object(params), "content")));
					pipelineHookRuns += 1;
					return { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: {} };
				},
				getActiveTools: () => ["write"],
				getAllTools: () => [],
			},
			new Set(["write"]),
			(toolName, params) => harness.writtenFiles.noteToolCall(toolName, params),
		);
		const kernel = new FakeKernel([
			{ type: "tool-call", callId: "c1", toolName: "write", args: { path: "src/tool.ts", content: "tool\n" } },
			result("nested-write", "undefined"),
		]);

		const cell = await runCell(harness, kernel, "nested-write", executeTool);

		expect({ pipelineHookRuns, reported: harness.reported, writtenFiles: cell.details.writtenFiles }).toEqual({
			pipelineHookRuns: 1,
			reported: [],
			writtenFiles: undefined,
		});
	});

	it("reports a failing hook in the result and still settles the cell as a success", async () => {
		const harness = writtenFilesHarness(async (report) => {
			if (String(report.input.path).endsWith("throws.ts")) throw new Error("hook host went away");
			return {
				toolCallId: "cell/reported-1",
				result: undefined,
				failures: [{ extensionPath: "/ext/diagnostics.ts", error: "language server crashed" }],
			};
		});
		const kernel = new WorkingKernel([result("hook-failure", "undefined")], () => {
			harness.workspace.write("src/handler.ts", "a\n");
			harness.workspace.write("src/throws.ts", "b\n");
		});

		const cell = await runCell(harness, kernel, "hook-failure");

		expect(cell.details.isError).toBeUndefined();
		expect(cell.details.cells?.[0]?.status).toBe("complete");
		expect(cell.details.writtenFiles).toEqual({
			files: ["src/handler.ts", "src/throws.ts"],
			total: 2,
			hooked: 1,
			hookFailures: [
				{ path: "src/handler.ts", error: "/ext/diagnostics.ts: language server crashed" },
				{ path: "src/throws.ts", error: "hook host went away" },
			],
		});
	});

	it("lists the files without running any hook on a hand whose loop runs elsewhere", async () => {
		const harness = writtenFilesHarness(undefined, { hooksRunHere: () => false });
		const kernel = new WorkingKernel([result("on-a-hand", "undefined")], () =>
			harness.workspace.write("src/a.ts", "a\n"),
		);

		const cell = await runCell(harness, kernel, "on-a-hand");

		expect(cell.details.writtenFiles).toEqual({ files: ["src/a.ts"], total: 1, hooked: 0 });
		expect(harness.reported).toEqual([]);
	});

	it("lists and hooks at most the limit and counts the rest", async () => {
		const harness = writtenFilesHarness();
		const written = WRITTEN_FILES_LIMIT + 3;
		const kernel = new WorkingKernel([result("many", "undefined")], () => {
			for (let index = 0; index < written; index++)
				harness.workspace.write(`src/f${String(index).padStart(2, "0")}.ts`, `export const v = ${index};\n`);
		});

		const cell = await runCell(harness, kernel, "many");

		expect(cell.details.writtenFiles?.files).toHaveLength(WRITTEN_FILES_LIMIT);
		expect(cell.details.writtenFiles).toMatchObject({ total: written, hooked: WRITTEN_FILES_LIMIT });
		expect(harness.reported).toHaveLength(WRITTEN_FILES_LIMIT);
	});

	it("says the writes were not checked when the workspace scan runs over its budget", async () => {
		const harness = writtenFilesHarness();
		harness.workspace.statusOutcome = { kind: "over_budget" };
		const kernel = new WorkingKernel([result("over-budget", "undefined")], () =>
			harness.workspace.write("src/a.ts", "a\n"),
		);

		const cell = await runCell(harness, kernel, "over-budget");

		expect(cell.details.isError).toBeUndefined();
		expect(cell.details.writtenFiles).toEqual({ files: [], total: 0, hooked: 0, unchecked: "over_budget" });
		expect(harness.reported).toEqual([]);
	});
});
