import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/index.ts";
import { bootstrapRuntime, buildToolRegistry } from "../../src/core/runtime/bootstrap.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createToolDispatcher } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { handToolCatalog, toolCatalog } from "../../src/modes/hand/tool-catalog.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A hand's tool runtime: the cwd-bound services, then the session-less registry (`bootstrapRuntime` +
 * `buildToolRegistry`), which is the composition the loopless runtime factory (senpi#5413) performs. Once
 * that factory is on `main`, this is `createLooplessRuntimeFactory(configuration, local)({ cwd })`.
 */
async function looplessDefinitions(cwd: string, agentDir: string, extensionFactories: InlineExtension[]) {
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir),
		resourceLoaderOptions: { noSkills: true, noContextFiles: true, noPromptTemplates: true, extensionFactories },
	});
	const dispatcher = createToolDispatcher({ runtime: "in-process" });
	const runtime = bootstrapRuntime({
		cwd: services.cwd,
		settingsManager: services.settingsManager,
		extensionsResult: services.resourceLoader.getExtensions(),
		modelRegistry: services.modelRegistry,
		toolDispatcher: dispatcher,
	});
	const registry = buildToolRegistry({
		baseToolDefinitions: runtime.baseToolDefinitions,
		runner: runtime.extensionRunner,
		dispatcher,
	});
	return {
		definitions: registry.definitions,
		dispose: async () => {
			await dispatcher.dispose();
			runtime.extensionRunner.invalidate("catalog parity test finished");
		},
	};
}

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
	const hand = await looplessDefinitions(cwd, agentDir, extensionFactories);
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
