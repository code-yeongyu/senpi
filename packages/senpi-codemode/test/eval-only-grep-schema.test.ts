import { createGrepToolDefinition } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { runEvalSchema } from "../src/bridges/schema-bridge.ts";

const GREP_HINT = 'tool.grep({ pattern: "...", path: "..." })';

function createWithheldSession() {
	const grep = createGrepToolDefinition("/tmp/project");
	const allTools = [{ name: grep.name, description: grep.description, parameters: grep.parameters }];
	return {
		getAllTools: () => allTools,
		getActiveToolNames: () => ["eval"],
		removedToolHints: { grep: GREP_HINT },
	};
}

describe("eval-only grep codemode surface", () => {
	it("exposes grep schema through the live catalog while withheld from direct tools", () => {
		const session = createWithheldSession();
		const schema = runEvalSchema({ name: "grep" }, { listTools: () => session.getAllTools() });
		const listed = runEvalSchema({}, { listTools: () => session.getAllTools() });

		expect(schema).toMatchObject({ name: "grep", parameters: { properties: { pattern: expect.anything() } } });
		expect(listed).toEqual({ tools: ["grep"] });
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.removedToolHints.grep).toContain("tool.grep(");
	});

	it("eagerly constructs the grep widget without loading a native prebuild", async () => {
		const previousNativePath = process.env.SENPI_GREP_NATIVE_PATH;
		process.env.SENPI_GREP_NATIVE_PATH = "sentinel-native-path";
		vi.resetModules();
		await import("../src/tool/tool-widgets.ts");
		expect(process.env.SENPI_GREP_NATIVE_PATH).toBe("sentinel-native-path");
		expect(createGrepToolDefinition("/tmp/project")).toBeDefined();
		if (previousNativePath === undefined) delete process.env.SENPI_GREP_NATIVE_PATH;
		else process.env.SENPI_GREP_NATIVE_PATH = previousNativePath;
	});
});
