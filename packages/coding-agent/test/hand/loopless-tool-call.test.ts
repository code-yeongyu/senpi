// senpi#5413 (RT10, brain/hand split): a loopless runtime validates each call's arguments against the tool's schema
// before the tool runs, as the agent loop does, and reports what loading its extensions reported.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createLooplessRuntimeFactory, type LooplessRuntime } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function echoExtension(ran: number[]) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "echo",
			label: "Echo",
			description: "Echoes its value.",
			parameters: Type.Object({ value: Type.Number() }),
			async execute(_toolCallId, params) {
				ran.push(params.value);
				return { content: [{ type: "text", text: `echo:${params.value}` }], details: {} };
			},
		});
	};
}

async function looplessRuntime(ran: number[], flags: readonly string[] = []): Promise<LooplessRuntime> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-call-"));
	const cwd = join(scratch, "project");
	await mkdir(cwd, { recursive: true });
	const runtime = await createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates", ...flags]),
			cwd,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		{ extensionFactories: [echoExtension(ran)] },
	)({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return runtime;
}

describe("loopless runtime tool calls (senpi#5413)", () => {
	it("refuses arguments that fail the tool's schema before the tool runs", async () => {
		const ran: number[] = [];
		const runtime = await looplessRuntime(ran);

		const result = await runtime.execute("echo", "call-invalid", { value: "not-a-number" });

		expect([result.isError, ran]).toEqual([true, []]);
	});

	it("runs a call whose arguments match the schema", async () => {
		const ran: number[] = [];
		const runtime = await looplessRuntime(ran);

		const result = await runtime.execute("echo", "call-valid", { value: 42 });

		expect([result.isError, ran]).toEqual([undefined, [42]]);
	});

	it("reports an extension that failed to load", async () => {
		const runtime = await looplessRuntime([], ["--extension", "/nonexistent/loopless-probe.ts"]);

		expect(runtime.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([expect.stringContaining("/nonexistent/loopless-probe.ts")]),
		);
	});
});
