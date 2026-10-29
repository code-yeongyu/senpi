import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerTerminalExtension from "../../../src/core/extensions/builtin/terminal/index.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.unstubAllEnvs();
});

// #4767: protect the assembled prompt-byte contract, not a prose snapshot.
// Tool metadata and before_agent_start hooks must not both emit the restart recipe.
describe("terminal guidance has one assembled home", () => {
	it.each([
		{ evalOnly: false, nativeBash: false },
		{ evalOnly: true, nativeBash: false },
		{ evalOnly: false, nativeBash: true },
		{ evalOnly: true, nativeBash: true },
	])("emits one restart recipe with $evalOnly eval and $nativeBash native bash", async ({ evalOnly, nativeBash }) => {
		// Given
		vi.stubEnv("PI_ANTHROPIC_BASH", nativeBash ? "1" : "0");
		const extensionFactories: Array<{ factory: ExtensionFactory; path: string }> = [
			{ factory: registerTerminalExtension, path: "<builtin:terminal>" },
		];
		if (evalOnly) {
			extensionFactories.push({
				path: "/fixture/eval.ts",
				factory: (pi) => {
					pi.registerTool({
						name: "eval",
						label: "eval",
						description: "Evaluate code.",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			});
		}
		const harness = await createHarness({
			extensionFactories,
			...(nativeBash
				? { api: "anthropic-messages", provider: "anthropic", models: [{ id: "claude-test", reasoning: false }] }
				: {}),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const build = harness.getExtensionRunner().createContext().getPromptCachePrefixRequest;
		if (!build) throw new Error("Missing prefix builder");

		// When
		const result = await build({ sizesOnly: true });

		// Then
		if (result.status !== "ready") throw new Error(result.reason);
		const prompt = result.request.context.systemPrompt ?? "";
		expect(prompt.match(/SENPI_MONITOR_RESTORED=1/g)).toHaveLength(1);
		expect(prompt.match(/^## Persistent terminal sessions$/gm)).toHaveLength(1);
		for (const branch of ["command", "path", 'type: "rpc", target']) {
			const call = `${evalOnly ? "tool.monitor" : "monitor"}({ ${branch.startsWith("type") ? "" : "description, "}${branch}`;
			expect(prompt.split(call)).toHaveLength(2);
		}
		if (nativeBash) expect(prompt).not.toMatch(/(?:tool\.)?bash\(\{ command, run_in_background:/);
	});
});
