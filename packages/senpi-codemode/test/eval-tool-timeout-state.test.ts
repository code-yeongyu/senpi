import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext } from "./eval/fakes.ts";

afterEach(() => {
	vi.useRealTimers();
});

function createTool(entries: Array<readonly [string, FakeKernel]>) {
	return createEvalTool({
		enabledLanguages: { js: true, py: true, rb: false, jl: false },
		kernelManager: new FakeManager(entries),
		cellTimeoutSeconds: 1,
		executeTool: vi.fn(),
	});
}

function interactiveContext() {
	return { ...fakeExtensionContext(), mode: "print" as const };
}

async function runTimedOutCell(
	tool: ReturnType<typeof createTool>,
	kernel: FakeKernel,
	language: "js" | "py",
): Promise<{ status: string; reason?: Error }> {
	kernel.deferNextRun();
	const outcome = tool
		.execute(
			"timeout-cell",
			{ language, code: "await forever", on_timeout: "error", timeout: 1 },
			undefined,
			undefined,
			interactiveContext(),
		)
		.then(
			() => ({ status: "fulfilled" }),
			(reason: Error) => ({ status: "rejected", reason }),
		);
	await vi.advanceTimersByTimeAsync(1_000);
	return await outcome;
}

describe("eval error-mode timeout names kernel state", () => {
	it("says the kernel remains running and state survived when the interrupt was cooperative", async () => {
		vi.useFakeTimers();
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = true;
		const tool = createTool([["py", kernel]]);

		const outcome = await runTimedOutCell(tool, kernel, "py");

		expect(outcome.status).toBe("rejected");
		expect(outcome.reason?.name).toBe("TimeoutError");
		expect(outcome.reason?.message).toContain("Cell timed out after 1000ms");
		expect(outcome.reason?.message).toMatch(/remains running|preserved|survived/i);
		expect(outcome.reason?.message).not.toMatch(/lost/i);
	});

	it("says state was lost when the kernel had to be restarted after the timeout", async () => {
		vi.useFakeTimers();
		const kernel = new FakeKernel([]);
		kernel.stateRetainedOnInterrupt = false;
		const tool = createTool([["js", kernel]]);

		const outcome = await runTimedOutCell(tool, kernel, "js");

		expect(outcome.status).toBe("rejected");
		expect(outcome.reason?.name).toBe("TimeoutError");
		expect(outcome.reason?.message).toContain("Cell timed out after 1000ms");
		expect(outcome.reason?.message).toMatch(/lost|restarted|recreated/i);
		expect(outcome.reason?.message).not.toMatch(/preserved|remains running/i);
	});
});
