import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

interface FauxContext {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

const FIXTURE_WINDOWS = [{ id: 7, title: "Fixture window" }];

// A search-exposed tool starts inactive; its kernel global must exist only once it is activated.
const fixtureTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "fx",
		label: "Fixture",
		description: "Fixture tool with kernel globals",
		exposure: "search",
		parameters: Type.Object({}),
		kernelPrelude: {
			javascript: "globalThis.fx = { windows: async () => JSON.parse((await tool.fx({})).text) };",
			python: "class _Fx:\n    def windows(self):\n        return tool.fx({})\nfx = _Fx()",
			documentation: "fx.windows() -> fixture windows",
			exports: ["fx"],
		},
		execute: async () => ({ content: [{ type: "text", text: JSON.stringify(FIXTURE_WINDOWS) }], details: {} }),
	});
};

async function createCodemodeHarness(): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-codemode-prelude-"));
	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		extensionFactories: [fixtureTool],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader });
	await harness.session.bindExtensions({});
	return {
		...harness,
		cleanup() {
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function runJsCell(harness: Harness, code: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("eval", { language: "js", code, summary: "probe fixture global" }), {
			stopReason: "toolUse",
		}),
		(context: FauxContext) => {
			const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
			return fauxAssistantMessage(toolResult ? getMessageText(toolResult) : "missing tool result");
		},
	]);
	await harness.session.prompt("run eval");
	return getAssistantTexts(harness).at(-1) ?? "";
}

describe("bundled codemode consumes ToolDefinition.kernelPrelude", () => {
	it("installs an activated tool's global in the next eval cell", async () => {
		// Given
		const harness = await createCodemodeHarness();
		try {
			const inactive = await runJsCell(harness, "return typeof fx");
			harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "fx"]);

			// When
			const active = await runJsCell(harness, "print(JSON.stringify(await fx.windows()))");

			// Then
			expect(inactive).toContain("undefined");
			expect(active).toContain(JSON.stringify(FIXTURE_WINDOWS));
		} finally {
			harness.cleanup();
		}
	});
});
