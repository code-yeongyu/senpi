// Brain/hand split plan row S17 (F02 digest): the executor's tool catalog carries one schema digest per tool,
// and a call built against another schema is refused before any effect, per tool.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolCatalog, checkCatalogCall } from "../../src/core/execution/catalog.ts";
import { type CatalogTool, toolSchemaDigest } from "../../src/core/execution/catalog-digest.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { bootstrapRuntime, buildToolRegistry } from "../../src/core/runtime/bootstrap.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult } from "../utilities.ts";

function tool(name: string, overrides: Partial<CatalogTool> = {}): CatalogTool {
	return {
		name,
		description: `${name} tool`,
		parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
		...overrides,
	};
}

// The same JSON value with every object's keys enumerated in reverse, as another process may decode it.
function reversedKeys(value: object): object {
	return Object.fromEntries(
		Object.keys(value)
			.reverse()
			.map((key) => [key, reversedValue(Reflect.get(value, key))]),
	);
}

function reversedValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(reversedValue);
	return typeof value === "object" && value !== null ? reversedKeys(value) : value;
}

describe("tool catalog digest (S17)", () => {
	it("gives one schema the same 32-byte digest whatever its key order", () => {
		// Given one schema, and the same schema with every object's keys in reverse order.
		const forward = tool("read", {
			parameters: Type.Object({ path: Type.String({ description: "file" }), limit: Type.Number() }),
		});
		const backward = { ...forward, parameters: reversedKeys(forward.parameters) };
		expect(JSON.stringify(backward.parameters)).not.toBe(JSON.stringify(forward.parameters));

		// Then both digest alike, as 32 bytes of hex.
		expect(toolSchemaDigest(forward)).toBe(toolSchemaDigest(backward));
		expect(toolSchemaDigest(forward)).toMatch(/^[0-9a-f]{64}$/u);
	});

	it.each<[string, Partial<CatalogTool>]>([
		["name", { name: "read_v2" }],
		["description", { description: "reads a file" }],
		["parameter schema", { parameters: Type.Object({ path: Type.String(), limit: Type.String() }) }],
		["output schema", { outputSchema: Type.Object({ bytes: Type.Number() }) }],
		["execution mode", { executionMode: "sequential" }],
	])("changes the digest when the %s changes", (_field, change) => {
		expect(toolSchemaDigest(tool("read", change))).not.toBe(toolSchemaDigest(tool("read")));
	});

	it("leaves the digest alone for display-only and code fields", () => {
		// Given a tool, and the same tool with another label and another body.
		const base: AgentTool = {
			...tool("read"),
			label: "Read",
			execute: async () => ({ content: [{ type: "text", text: "a" }], details: {} }),
		};
		const relabelled: AgentTool = {
			...base,
			label: "Read file",
			execute: async () => ({ content: [{ type: "text", text: "b" }], details: {} }),
		};

		// Then the schema digest is the same.
		expect(toolSchemaDigest(relabelled)).toBe(toolSchemaDigest(base));
	});

	it("refuses only the call whose own tool changed or left (per-tool staleness)", () => {
		// Given calls built against a catalog of two tools.
		const before = buildToolCatalog([tool("read"), tool("write")]);
		const readCall = { name: "read", schemaDigest: before.get("read")?.schemaDigest ?? "" };
		const writeCall = { name: "write", schemaDigest: before.get("write")?.schemaDigest ?? "" };
		expect(checkCatalogCall(before, readCall)).toEqual({ ok: true, entry: before.get("read") });

		// When `write` changes its schema.
		const changed = buildToolCatalog([tool("read"), tool("write", { description: "writes a file" })]);

		// Then the `read` call still runs and the `write` call is stale.
		expect(checkCatalogCall(changed, readCall).ok).toBe(true);
		expect(checkCatalogCall(changed, writeCall)).toEqual({ ok: false, reason: "schema_stale", name: "write" });

		// And once `write` is gone, its call names an unknown tool.
		const removed = buildToolCatalog([tool("read")]);
		expect(checkCatalogCall(removed, writeCall)).toEqual({ ok: false, reason: "tool_unknown", name: "write" });
	});
});

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function probeExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "probe",
		label: "Probe",
		description: "Echoes its input.",
		parameters: Type.Object({ value: Type.String() }),
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `probe:${params.value}` }], details: {} };
		},
	});
}

describe("tool catalog of the runtime registry (S17, F02)", () => {
	it("lists every executable tool, and a wrapped extension tool digests as its definition", async () => {
		// Given the registry a runtime builds from base tools and an extension tool.
		harness = await createHarness({ extensionFactories: [probeExtension] });
		const extensionsResult = await createTestExtensionsResult([probeExtension], harness.tempDir);
		const runtime = bootstrapRuntime({
			cwd: harness.tempDir,
			settingsManager: SettingsManager.inMemory(),
			extensionsResult,
			modelRegistry: harness.modelRegistry,
		});
		const registry = buildToolRegistry({
			baseToolDefinitions: runtime.baseToolDefinitions,
			runner: runtime.extensionRunner,
		});

		// When the catalog is built from its executable tools.
		const catalog = buildToolCatalog(registry.toolRegistry.values());

		// Then it lists them in registry order, and the wrapper changed nothing the digest covers.
		expect([...catalog.keys()]).toEqual([...registry.toolRegistry.keys()]);
		const probe = registry.definitions.get("probe")?.definition;
		expect(probe).toBeDefined();
		if (probe === undefined) return;
		expect(catalog.get("probe")?.schemaDigest).toBe(toolSchemaDigest(probe));
		expect(catalog.get("probe")?.executionMode).toBe("sequential");
	});
});
