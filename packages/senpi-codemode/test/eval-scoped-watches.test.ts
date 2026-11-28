import { describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { SCOPE_MONITOR_OP } from "../src/bridge/reserved.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, fakeExtensionContext } from "./eval/fakes.ts";

// senpi#7381: a cell that ends without an ok result cannot close its scope's watches; the host stops them.
function runWith(messages: KernelToHostMessage[], killResult: { isError?: boolean; text: string }) {
	const kernel = new FakeKernel(messages);
	const executeTool = vi.fn(async () => ({
		content: [{ type: "text" as const, text: killResult.text }],
		details: undefined,
		...(killResult.isError ? { isError: true } : {}),
	}));
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: { getKernel: async () => kernel },
		cellTimeoutSeconds: 30,
		executeTool,
	});
	const result = tool.execute(
		crypto.randomUUID(),
		{ language: "js", code: "scoped", summary: "scoped watches" },
		undefined,
		undefined,
		fakeExtensionContext(),
	);
	return { executeTool, result };
}

const held = (bashId: string, isHeld: boolean): KernelToHostMessage => ({
	type: "status",
	event: { op: SCOPE_MONITOR_OP, bashId, held: isHeld },
});
const failed: KernelToHostMessage = {
	type: "result",
	cellId: "c",
	ok: false,
	error: { message: "JS cell interrupted: timeout" },
	durationMs: 1,
};
const succeeded: KernelToHostMessage = { type: "result", cellId: "c", ok: true, valueRepr: "1", durationMs: 1 };

describe("scoped watches a JS cell still holds", () => {
	it("stops a held watch when the cell ends without an ok result, and only the held one", async () => {
		const { executeTool, result } = runWith(
			[held("bash_1", true), held("bash_2", true), held("bash_2", false), failed],
			{
				text: "Killed bash_1.",
			},
		);
		const settled = await result;

		expect(executeTool.mock.calls).toEqual([["kill_bash", { bash_id: "bash_1" }]]);
		expect(JSON.stringify(settled.details.statusEvents ?? [])).not.toContain(SCOPE_MONITOR_OP);
	});

	it("leaves the watches of a cell that settled ok to that cell", async () => {
		const { executeTool, result } = runWith([held("bash_3", true), succeeded], { text: "Killed bash_3." });
		await result;

		expect(executeTool).not.toHaveBeenCalled();
	});

	it("reports a held watch that would not stop, but not one that already ended", async () => {
		const stuck = runWith([held("bash_4", true), failed], { isError: true, text: "permission denied" });
		const ended = runWith([held("bash_5", true), failed], {
			isError: true,
			text: "No terminal session found with id: bash_5",
		});

		expect(JSON.stringify((await stuck.result).content)).toContain(
			"scoped watch bash_4 did not stop: permission denied",
		);
		expect(JSON.stringify((await ended.result).content)).not.toContain("did not stop");
	});
});
