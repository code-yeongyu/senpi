import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { handToolCatalog, toolCatalog } from "../../src/modes/hand/tool-catalog.ts";
import { createLooplessRuntimeFactory } from "../../src/modes/rpc/runtime-factory-loopless.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixtureExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "echo",
		label: "Echo",
		description: "Echoes its value.",
		parameters: Type.Object({ value: Type.Number(), note: Type.Optional(Type.String()) }),
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: String(params.value) }], details: {} };
		},
	});
	pi.registerTool({
		name: "find_widget",
		label: "Find widget",
		description: "Looks up a widget by id.",
		parameters: Type.Object({ id: Type.String() }),
		exposure: "search",
		searchText: "widget lookup by identifier",
		searchKeywords: ["widget", "lookup"],
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: params.id }], details: {} };
		},
	});
}

it("a hand exposes the same tool catalog as the fused engine for the same configuration", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-hand-catalog-"));
	const cwd = join(scratch, "project");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd, { recursive: true });
	const configuration = {
		parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
		cwd,
		agentDir,
		appMode: "rpc" as const,
	};
	const extensionFactories: InlineExtension[] = [...builtInExtensions, fixtureExtension];

	const fused = await createCliRuntimeFactory(configuration, { extensionFactories })({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const hand = await createLooplessRuntimeFactory(configuration, { extensionFactories })({ cwd });
	cleanups.push(async () => {
		await hand.dispose();
		fused.session.dispose();
		await rm(scratch, { recursive: true, force: true });
	});

	const fusedCatalog = toolCatalog(fused.session.getAllTools());
	const handCatalog = handToolCatalog(hand.definitions);

	expect(fusedCatalog.map((tool) => tool.name)).toEqual(
		expect.arrayContaining(["read", "bash", "echo", "find_widget"]),
	);
	expect(JSON.stringify(handCatalog)).toBe(JSON.stringify(fusedCatalog));
}, 60_000);
