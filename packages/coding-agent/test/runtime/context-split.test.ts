// senpi#5223 (RT2, brain/hand split): an extension runner without a session serves the runtime part of the
// extension context and refuses loop-side members by name. Guards the F06 extension-composition and F13
// settings/trust surfaces for a runtime that owns no transcript.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type ExtensionAPI, type ExtensionContext, ExtensionRunner } from "../../src/core/extensions/index.ts";
import type { ExtensionRuntimeContext } from "../../src/core/extensions/types.ts";
import { buildToolRegistry } from "../../src/core/runtime/bootstrap.ts";
import { createToolDispatcher } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const seen: ExtensionContext[] = [];

function probeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Echoes its input.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			seen.push(ctx);
			return { content: [{ type: "text", text: `probe:${params.value}` }], details: {} };
		},
	});
}

async function sessionlessRunner(cwd: string): Promise<ExtensionRunner> {
	const extensionsResult = await createTestExtensionsResult([probeExtension], cwd);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	return new ExtensionRunner(extensionsResult.extensions, extensionsResult.runtime, cwd, undefined, modelRegistry);
}

describe("extension context without a session (senpi#5223)", () => {
	it("serves the runtime members", async () => {
		const runner = await sessionlessRunner(process.cwd());
		const context: ExtensionRuntimeContext = runner.createContext();

		expect(context.cwd).toBe(process.cwd());
		expect(context.mode).toBe("print");
		expect(context.hasUI).toBe(false);
		expect(context.loadedExtensionPaths).toHaveLength(1);
		expect(context.isProjectTrusted()).toBe(true);
		expect(context.getImageSettings()).toEqual(expect.objectContaining({ autoResize: expect.any(Boolean) }));
		expect(typeof context.agentDir).toBe("string");
	});

	it("has no session identity", async () => {
		const runner = await sessionlessRunner(process.cwd());
		const context = runner.createContext();

		expect("sessionManager" in context).toBe(false);
		expect("goalStoreFile" in context).toBe(false);
	});

	it.each([
		["model", (context: ExtensionContext) => context.model],
		["isIdle", (context: ExtensionContext) => context.isIdle()],
		["abort", (context: ExtensionContext) => context.abort()],
		["getSystemPrompt", (context: ExtensionContext) => context.getSystemPrompt()],
	])("refuses the loop-side member %s by name", async (member, read) => {
		const runner = await sessionlessRunner(process.cwd());

		expect(() => read(runner.createContext())).toThrow(`${member} is loop-side and not bound`);
	});

	it("runs an extension tool from the runtime registry with the runtime context", async () => {
		seen.length = 0;
		const runner = await sessionlessRunner(process.cwd());
		const registry = buildToolRegistry({
			baseToolDefinitions: new Map(),
			runner,
			dispatcher: createToolDispatcher({ runtime: "in-process" }),
		});
		const probe = registry.toolRegistry.get("probe");
		if (probe === undefined) throw new Error("probe was not registered");

		const result = await probe.execute("call-1", { value: "x" }, undefined, undefined);

		expect(result.content).toEqual([{ type: "text", text: "probe:x" }]);
		expect(seen[0]?.cwd).toBe(process.cwd());
		expect(seen[0] !== undefined && "sessionManager" in seen[0]).toBe(false);
		expect(() => seen[0]?.model).toThrow("model is loop-side and not bound");
	});
});
