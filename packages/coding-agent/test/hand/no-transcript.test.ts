// senpi#5413 (RT10, brain/hand split; R16.h): a loopless worker runtime writes no transcript. Tool calls run
// on a runner without a session, so their context holds no session manager and no session file exists anywhere
// under the agent dir or the cwd.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createLooplessRuntimeFactory } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sessionIdentityProbe(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "session_identity",
		label: "Session identity",
		description: "Reports whether the tool's context carries a session manager.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: String("sessionManager" in ctx) }], details: {} };
		},
	});
}

async function filesUnder(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe("loopless worker runtime transcript (senpi#5413)", () => {
	it("writes no session file for the tool calls it runs", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-transcript-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const cwd = join(scratch, "project");
		const agentDir = join(scratch, "agent");
		await mkdir(cwd, { recursive: true });
		await writeFile(join(cwd, "README.md"), "project\n");
		const runtime = await createLooplessRuntimeFactory(
			{
				parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
				cwd,
				agentDir,
				appMode: "rpc",
			},
			{ extensionFactories: [sessionIdentityProbe] },
		)({ cwd });
		cleanups.push(() => runtime.dispose());

		const first = await runtime.execute("session_identity", "call-1", {});
		const second = await runtime.execute("session_identity", "call-2", {});

		expect([first, second].map((result) => result.content)).toEqual([
			[{ type: "text", text: "false" }],
			[{ type: "text", text: "false" }],
		]);
		expect((await filesUnder(scratch)).filter((path) => path.endsWith(".jsonl"))).toEqual([]);
	});
});
