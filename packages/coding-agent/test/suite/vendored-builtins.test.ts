import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { getTextOutput } from "../../src/core/tools/render-utils.ts";

type ToolResultHandler = (event: unknown, context: unknown) => unknown | Promise<unknown>;

interface FactoryProbe {
	tools: Set<string>;
	commands: Set<string>;
	events: Set<string>;
	toolResult?: ToolResultHandler;
}

function runFactory(factory: ExtensionFactory): FactoryProbe {
	const probe: FactoryProbe = { tools: new Set(), commands: new Set(), events: new Set() };
	const pi = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "registerTool") return (tool: { name: string }) => probe.tools.add(tool.name);
				if (prop === "registerCommand") return (name: string) => probe.commands.add(name);
				if (prop === "on")
					return (event: string, handler: ToolResultHandler) => {
						probe.events.add(event);
						if (event === "tool_result") probe.toolResult = handler;
					};
				return () => undefined;
			},
		},
	) as unknown as ExtensionAPI;
	factory(pi);
	return probe;
}

function factoryFor(id: string): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === id);
	if (!entry) throw new Error(`builtin extension not registered: ${id}`);
	return entry.factory;
}

describe("vendored pi-* builtins", () => {
	it("registers every vendored extension in the builtin registry", () => {
		const ids = builtinExtensions.map((extension) => extension.id);

		expect(ids).toEqual(expect.arrayContaining(["websearch", "webfetch", "nested-agents-md", "rules", "goal"]));
	});

	it("exposes the web_search tool and /websearch command from the websearch builtin", () => {
		const probe = runFactory(factoryFor("websearch"));

		expect(probe.tools.has("web_search")).toBe(true);
		expect(probe.commands.has("websearch")).toBe(true);
	});

	it("exposes the webfetch tool when enabled by default", () => {
		const probe = runFactory(factoryFor("webfetch"));

		expect(probe.tools.has("webfetch")).toBe(true);
	});

	it("registers the /nested-agents command from the nested-agents-md builtin", () => {
		const probe = runFactory(factoryFor("nested-agents-md"));

		expect(probe.commands.has("nested-agents")).toBe(true);
	});

	it("appends nested AGENTS.md as model-only text without changing its bytes (#2041)", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "nested-model-only-")));
		try {
			const directory = join(root, "nested");
			const target = join(directory, "example.ts");
			const agentsPath = join(directory, "AGENTS.md");
			const ruleBody = "# Nested rule\n\nKeep the nested fixture token.\n";
			await mkdir(directory);
			await writeFile(agentsPath, ruleBody);
			await writeFile(target, "export const value = 1;\n");
			const probe = runFactory(factoryFor("nested-agents-md"));
			if (!probe.toolResult) throw new Error("Nested tool-result handler was not registered");
			const body: TextContent = { type: "text", text: "export const value = 1;\n" };
			const result = await probe.toolResult(
				{
					type: "tool_result",
					toolName: "read",
					toolCallId: "nested-read",
					input: { path: target },
					content: [body],
					details: undefined,
					isError: false,
				},
				{ cwd: root, hasUI: false },
			);
			expect(result).toEqual({
				content: [
					body,
					{
						type: "text",
						text: `\n\n[Directory Context: ${agentsPath}]\n${ruleBody}`,
						audience: "model",
					},
				],
			});
			if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
				throw new Error("Nested injection did not return content");
			}
			expect(result.content[0]).toBe(body);
			expect(getTextOutput({ content: result.content }, false)).toBe(body.text);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("registers the /rules and /reload-rules commands from the rules builtin", () => {
		const probe = runFactory(factoryFor("rules"));

		expect(probe.commands.has("rules")).toBe(true);
		expect(probe.commands.has("reload-rules")).toBe(true);
	});
});
