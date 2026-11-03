// senpi#5413 (RT10, brain/hand split): a loopless runtime registers exactly the tools a session registers for the
// same tool flags, so a hand started with `--tools`, `--exclude-tools` or `--no-tools` serves that set and no other.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

function echoExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value.",
		parameters: Type.Object({ value: Type.Number() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: String(params.value) }], details: {} };
		},
	});
}

async function catalog(flags: readonly string[]): Promise<string[]> {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-filters-"));
	const cwd = join(scratch, "project");
	await mkdir(cwd, { recursive: true });
	const runtime = await createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates", ...flags]),
			cwd,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		{ extensionFactories: [echoExtension] },
	)({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	return [...runtime.definitions.keys()];
}

describe("loopless runtime tool filters (senpi#5413)", () => {
	it("--tools registers only the named tools", async () => {
		expect((await catalog(["--tools", "read,echo"])).sort()).toEqual(["echo", "read"]);
	});

	it("--exclude-tools drops the named tools and keeps the rest", async () => {
		const names = await catalog(["--exclude-tools", "bash,echo"]);

		expect([names.includes("bash"), names.includes("echo"), names.includes("read")]).toEqual([false, false, true]);
	});

	it("--no-tools registers no tool", async () => {
		expect(await catalog(["--no-tools"])).toEqual([]);
	});
});
