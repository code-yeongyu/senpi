// senpi#5413 (RT10, brain/hand split): until the remote tool executor runs the extensions' tool_call/tool_result
// handlers for a tool-execution-only process, a loopless runtime refuses every tool call unless the in-process test
// harness built it. Security contract: an untrusted call must never reach a tool past its permission checks.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import {
	grantLooplessExecuteToTestHarness,
	type LooplessExecuteGrant,
	LooplessExecuteRefusedError,
} from "../../src/modes/rpc/loopless-execute-grant.ts";
import { createLooplessRuntimeFactory, type LooplessRuntime } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function looplessRuntime(
	ran: string[],
	executeGrant: LooplessExecuteGrant | undefined,
): Promise<LooplessRuntime> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-guard-"));
	const cwd = join(scratch, "project");
	await mkdir(cwd, { recursive: true });
	const probe = (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "probe",
			label: "Probe",
			description: "Records that it ran.",
			parameters: Type.Object({}),
			async execute(toolCallId) {
				ran.push(toolCallId);
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		});
	};
	const runtime = await createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
			cwd,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		{ extensionFactories: [probe], ...(executeGrant === undefined ? {} : { executeGrant }) },
	)({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return runtime;
}

describe("loopless runtime execute guard (senpi#5413)", () => {
	it("refuses every call of a runtime built without a grant, running nothing", async () => {
		const ran: string[] = [];
		const runtime = await looplessRuntime(ran, undefined);

		await expect(runtime.execute("probe", "call-ungranted", {})).rejects.toBeInstanceOf(LooplessExecuteRefusedError);
		expect(ran).toEqual([]);
	});

	it("refuses a grant this module did not issue, even one naming an allowed caller", async () => {
		const ran: string[] = [];
		const forged: LooplessExecuteGrant = { caller: "in-process-test-harness" };
		const runtime = await looplessRuntime(ran, forged);

		await expect(runtime.execute("probe", "call-forged", {})).rejects.toBeInstanceOf(LooplessExecuteRefusedError);
		expect(ran).toEqual([]);
	});

	it("issues no grant outside the test harness", () => {
		vi.stubEnv("VITEST", "");

		expect(() => grantLooplessExecuteToTestHarness()).toThrow(LooplessExecuteRefusedError);
	});

	it("runs the call for the test harness's grant", async () => {
		const ran: string[] = [];
		const runtime = await looplessRuntime(ran, grantLooplessExecuteToTestHarness());

		await runtime.execute("probe", "call-granted", {});

		expect(ran).toEqual(["call-granted"]);
	});
});
