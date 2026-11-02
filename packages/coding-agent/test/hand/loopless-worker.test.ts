// senpi#5413 (RT10, brain/hand split): a session worker's runtime with only the agent loop removed. It is
// built from the same launch configuration as the CLI runtime, serves the built-in and extension tools,
// and binds no loop, so an extension that tries to start a turn is refused. Guards the F41 loopless-worker
// surface.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { grantLooplessExecuteToTestHarness } from "../../src/modes/rpc/loopless-execute-grant.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import {
	createLooplessRuntimeFactory,
	type LooplessRuntime,
	LooplessToolNotFoundError,
} from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function handExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: JSON.stringify({ value: params.value }) }], details: {} };
		},
	});
	pi.registerTool({
		name: "start_turn",
		label: "Start turn",
		description: "Tries to start an agent turn from inside a tool call.",
		parameters: Type.Object({}),
		async execute() {
			try {
				pi.sendUserMessage("continue");
				return { content: [{ type: "text", text: "turn started" }], details: {} };
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				return { content: [{ type: "text", text: `refused: ${message}` }], details: {} };
			}
		},
	});
}

async function looplessRuntime(): Promise<LooplessRuntime> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-loopless-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd, { recursive: true });
	await writeFile(join(cwd, "note.txt"), "written before the call\n");
	const factory = createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
			cwd,
			agentDir,
			appMode: "rpc",
		},
		{ extensionFactories: [handExtension], executeGrant: grantLooplessExecuteToTestHarness() },
	);
	const runtime = await factory({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return runtime;
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

describe("loopless worker runtime (senpi#5413)", () => {
	it("serves the built-in tools and the configured extension's tools", async () => {
		const runtime = await looplessRuntime();

		const names = [...runtime.definitions.keys()];

		expect(names).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "echo", "start_turn"]));
		expect(runtime.definitions.get("read")?.sourceInfo.source).toBe("builtin");
		expect(runtime.definitions.get("echo")?.sourceInfo.source).not.toBe("builtin");
	});

	it("runs a built-in tool call in the runtime's cwd", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("read", "call-read", { path: "note.txt" });

		expect(text(result)).toContain("written before the call");
	});

	it("runs echo({value:42}) through the extension's tool", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("echo", "call-echo", { value: 42 });

		expect(text(result)).toBe('{"value":42}');
	});

	it("binds no agent loop: an extension that tries to start a turn is refused", async () => {
		const runtime = await looplessRuntime();

		const result = await runtime.execute("start_turn", "call-turn", {});

		expect(text(result)).toMatch(/^refused: Extension runtime not initialized/);
	});

	it("refuses an unknown tool before anything runs", async () => {
		const runtime = await looplessRuntime();

		await expect(runtime.execute("missing", "call-missing", {})).rejects.toBeInstanceOf(LooplessToolNotFoundError);
	});
});
