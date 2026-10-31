// senpi#5219 (RT1, brain/hand split): the tool registry is built without a session, and a session builds the
// same registry through the same functions. Guards the F01 core-registry and F02 extension-tools/wrappers surfaces.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/index.ts";
import { bootstrapRuntime, buildToolRegistry } from "../../src/core/runtime/bootstrap.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult } from "../utilities.ts";

interface ToolView {
	name: string;
	description: string;
	parameters: unknown;
	source: string;
	path: string;
}

const seenContexts: ExtensionContext[] = [];

function probeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Echoes its input.",
		parameters: Type.Object({ value: Type.String() }),
		promptSnippet: "probe echoes",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			seenContexts.push(ctx);
			return { content: [{ type: "text", text: `probe:${params.value}` }], details: {} };
		},
	});
	pi.registerTool({
		name: "base_b",
		label: "Override",
		description: "Extension tool that replaces the base tool of the same name.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "override" }], details: {} };
		},
	});
	pi.registerTool({
		name: "hidden_probe",
		label: "Hidden",
		description: "Excluded by the filter.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "hidden" }], details: {} };
		},
	});
}

function baseTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `base ${name}`,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: name }], details: {} };
		},
	};
}

const baseTools = (): AgentTool[] => [baseTool("base_a"), baseTool("base_b"), baseTool("base_c")];

function view(entries: Iterable<{ definition: { name: string; description: string; parameters: unknown }; sourceInfo: { source: string; path: string } }>): ToolView[] {
	return [...entries].map(({ definition, sourceInfo }) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		source: sourceInfo.source,
		path: sourceInfo.path,
	}));
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	seenContexts.length = 0;
});

async function bootstrapLike(
	h: Harness,
	filters: { allowedToolNames?: string[]; excludedToolNames?: string[] },
): Promise<ReturnType<typeof buildToolRegistry>> {
	const extensionsResult = await createTestExtensionsResult([probeExtension], h.tempDir);
	const runtime = bootstrapRuntime({
		cwd: h.tempDir,
		settingsManager: SettingsManager.inMemory(),
		extensionsResult,
		modelRegistry: h.modelRegistry,
		baseToolsOverride: Object.fromEntries(baseTools().map((tool) => [tool.name, tool])),
	});
	return buildToolRegistry({
		baseToolDefinitions: runtime.baseToolDefinitions,
		runner: runtime.extensionRunner,
		...(filters.allowedToolNames ? { allowedToolNames: new Set(filters.allowedToolNames) } : {}),
		...(filters.excludedToolNames ? { excludedToolNames: new Set(filters.excludedToolNames) } : {}),
	});
}

describe("runtime bootstrap builds the session's tool registry without a session (senpi#5219)", () => {
	it.each([
		{ label: "no filter", filters: {} },
		{ label: "excluded tools", filters: { excludedToolNames: ["hidden_probe", "base_c"] } },
		{ label: "allowed tools", filters: { allowedToolNames: ["probe", "base_a", "base_b"] } },
	])("matches AgentSession for the same inputs ($label)", async ({ filters }) => {
		harness = await createHarness({ tools: baseTools(), extensionFactories: [probeExtension], ...filters });
		const registry = await bootstrapLike(harness, filters);

		const sessionView = harness.session.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			source: tool.sourceInfo.source,
			path: tool.sourceInfo.path,
		}));
		expect(view(registry.definitions.values())).toEqual(sessionView);
		expect([...registry.toolRegistry.keys()]).toEqual(
			sessionView.map((tool) => tool.name).filter((name) => harness?.session.getRegisteredTool(name) !== undefined),
		);
		for (const name of registry.toolRegistry.keys()) {
			expect(harness.session.getRegisteredTool(name)?.description).toBe(registry.toolRegistry.get(name)?.description);
		}
	});

	it("lets an extension tool replace a base tool and keeps the base order first", async () => {
		harness = await createHarness({ tools: baseTools(), extensionFactories: [probeExtension] });
		const registry = await bootstrapLike(harness, {});

		expect([...registry.toolRegistry.keys()]).toEqual(["base_a", "base_b", "base_c", "probe", "hidden_probe"]);
		expect(registry.definitions.get("base_b")?.definition.label).toBe("Override");
		expect(registry.definitions.get("base_a")?.sourceInfo.source).toBe("builtin");
	});

	it("runs an extension tool through its wrapper with the runner's context and no session", async () => {
		harness = await createHarness({ tools: baseTools() });
		const registry = await bootstrapLike(harness, {});
		const probe = registry.toolRegistry.get("probe");
		if (probe === undefined) throw new Error("probe was not registered");

		const result = await probe.execute("call-1", { value: "x" }, undefined, undefined);

		expect(result.content).toEqual([{ type: "text", text: "probe:x" }]);
		expect(seenContexts).toHaveLength(1);
		expect(seenContexts[0]?.cwd).toBe(harness.tempDir);
	});
});
