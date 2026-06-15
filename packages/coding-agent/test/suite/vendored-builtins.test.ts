import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";

interface FactoryProbe {
	tools: Set<string>;
	commands: Set<string>;
	events: Set<string>;
}

function runFactory(factory: ExtensionFactory): FactoryProbe {
	const probe: FactoryProbe = { tools: new Set(), commands: new Set(), events: new Set() };
	const pi = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "registerTool") return (tool: { name: string }) => probe.tools.add(tool.name);
				if (prop === "registerCommand") return (name: string) => probe.commands.add(name);
				if (prop === "on") return (event: string) => probe.events.add(event);
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

	it("registers the /rules and /reload-rules commands from the rules builtin", () => {
		const probe = runFactory(factoryFor("rules"));

		expect(probe.commands.has("rules")).toBe(true);
		expect(probe.commands.has("reload-rules")).toBe(true);
	});
});
