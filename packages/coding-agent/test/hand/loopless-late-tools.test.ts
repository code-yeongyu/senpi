// senpi#5747: a loopless runtime's tool registry follows tools its extensions register after it was built (an MCP
// server's tools attach at a context's first tool call), so they are listed and callable on the hand.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { grantLooplessExecuteToTestHarness } from "../../src/modes/rpc/loopless-execute-grant.ts";
import { createLooplessRuntimeFactory } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("lists and runs a tool an extension registered after the runtime was built", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-5747-"));
	const cwd = join(scratch, "project");
	await mkdir(cwd, { recursive: true });
	let api: ExtensionAPI | undefined;
	const runtime = await createLooplessRuntimeFactory(
		{
			parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
			cwd,
			agentDir: join(scratch, "agent"),
			appMode: "rpc",
		},
		{
			extensionFactories: [
				...builtInExtensions,
				(pi) => {
					api = pi;
				},
			],
			executeGrant: grantLooplessExecuteToTestHarness(),
		},
	)({ cwd });
	cleanups.push(async () => {
		await runtime.dispose();
		await rm(scratch, { recursive: true, force: true });
	});
	if (api === undefined) throw new Error("the extension never loaded");
	const before = [...runtime.definitions.keys()];

	// What an MCP attach does once its server answers tools/list.
	api.registerTool({
		name: "browser_navigate",
		label: "Navigate",
		description: "Opens a URL.",
		parameters: Type.Object({ url: Type.String() }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `opened ${params.url}` }], details: {} };
		},
	});

	expect(before).not.toContain("browser_navigate");
	expect([...runtime.definitions.keys()]).toContain("browser_navigate");
	const result = await runtime.execute("browser_navigate", "call-late", { url: "https://example.test" });
	expect([result.isError, result.content]).toEqual([
		undefined,
		[{ type: "text", text: "opened https://example.test" }],
	]);
	// The built-in tools stay as they were.
	expect([...runtime.definitions.keys()]).toEqual(expect.arrayContaining(before));
});
