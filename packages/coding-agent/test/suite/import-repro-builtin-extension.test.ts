import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";

interface FactoryProbe {
	readonly commands: Set<string>;
}

function runFactory(factory: ExtensionFactory): FactoryProbe {
	const probe: FactoryProbe = { commands: new Set() };
	const pi = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "registerCommand") return (name: string) => probe.commands.add(name);
				return () => undefined;
			},
		},
	) as unknown as ExtensionAPI;
	factory(pi);
	return probe;
}

describe("import-repro builtin extension", () => {
	it("registers the /ir command", () => {
		const entry = builtinExtensions.find((extension) => extension.id === "import-repro");
		if (entry === undefined) {
			throw new Error("missing import-repro builtin extension");
		}

		const probe = runFactory(entry.factory);

		expect(probe.commands.has("ir")).toBe(true);
	});
});
