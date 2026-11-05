import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import type { ExtensionFactory, ToolPermissionRequest } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { sessionExecutor } from "./executor-harness.ts";

// F08: on the executor, the permission system classifies a call through the tool's own `permissionParser`, applied
// to the arguments the shim produced.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function tieredTool(runs: string[]): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "tiered",
			label: "tiered",
			description: "Fixture tool with its own permission tiers and a legacy argument shim",
			parameters: Type.Object({ mode: Type.String() }),
			prepareArguments: (args) => {
				if (typeof args !== "object" || args === null) return { mode: "" };
				return { mode: String("legacy" in args ? args.legacy : "mode" in args ? args.mode : "") };
			},
			permissionParser: (input): ToolPermissionRequest[] => {
				const tier = input.mode === "write" ? "exec" : "read";
				return [{ permission: "tiered", patterns: [tier], always: [tier] }];
			},
			execute: async (_id, params) => {
				runs.push(params.mode);
				return { content: [{ type: "text", text: `ran ${params.mode}` }], details: {} };
			},
		});
	};
}

async function openTieredExecutor() {
	const runs: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			{ factory: permissionSystemExtension, path: "<builtin:permission-system>" },
			{ factory: tieredTool(runs), path: "<test:tiered>" },
		],
		extensionFlagValues: new Map([["permission", "tiered:exec=deny"]]),
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({});
	return { executor: await sessionExecutor(harness.session), runs };
}

describe("F08: permissionParser paths on the prepared executor", () => {
	it("denies the parser's exec tier before the body runs", async () => {
		// Given
		const { executor, runs } = await openTieredExecutor();

		// When
		const prepared = await executor.prepare("f08-write", "tiered", { mode: "write" });

		// Then
		expect({ kind: prepared.kind, runs }).toEqual({ kind: "blocked", runs: [] });
	});

	it("lets the parser's read tier through to the body", async () => {
		// Given
		const { executor, runs } = await openTieredExecutor();

		// When
		const prepared = await executor.prepare("f08-look", "tiered", { mode: "look" });
		const released = await executor.release("f08-look");

		// Then
		expect({ prepared: prepared.kind, released: released.kind, runs }).toEqual({
			prepared: "prepared",
			released: "settled",
			runs: ["look"],
		});
	});

	it("classifies the shim's output, not the raw call", async () => {
		// Given
		const { executor, runs } = await openTieredExecutor();

		// When
		const prepared = await executor.prepare("f08-shim", "tiered", { legacy: "write" });

		// Then
		expect({ kind: prepared.kind, runs }).toEqual({ kind: "blocked", runs: [] });
	});
});
