import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideAuto } from "../../src/core/extensions/builtin/permission-system/auto-policy.ts";
import { PERMISSION_PRESET_NAMES } from "../../src/core/extensions/builtin/permission-system/cli.ts";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import {
	createBuiltinParserRegistry,
	permissionRequestsFor,
} from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import type { Action } from "../../src/core/extensions/builtin/permission-system/types.ts";
import type { ExtensionFactory, ToolInfo } from "../../src/core/extensions/types.ts";
import { createPermissionP0Host } from "../suite/regressions/permission-p0-host.ts";

// senpi#3210: an eval cell is arbitrary code. Under every preset the eval call itself must be at
// least as restricted as the strictest direct tool that performs the same kinds of side effect
// (shell, file edit, file write), so no preset can be bypassed by wrapping an action in a cell.

const STRICTNESS: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

let project = "";
let outsideDir = "";

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "senpi-eval-floor-"));
	mkdirSync(join(project, ".git"), { recursive: true });
	writeFileSync(join(project, "notes.txt"), "notes\n");
	outsideDir = mkdtempSync(join(tmpdir(), "senpi-eval-floor-outside-"));
});

afterAll(() => {
	rmSync(project, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
});

function decisionFor(
	preset: (typeof PERMISSION_PRESET_NAMES)[number],
	toolName: string,
	input: Record<string, unknown>,
): Action {
	const registry = createBuiltinParserRegistry();
	const requests = registry.parse(toolName, input, project);
	return requests
		.map((request) => evaluate(request.permission, request.patterns, rulesForPreset(preset)).action)
		.reduce<Action>(
			(strictest, action) => (STRICTNESS[action] > STRICTNESS[strictest] ? action : strictest),
			"allow",
		);
}

describe("eval is never looser than shell, edit or write (senpi#3210)", () => {
	it.each(PERMISSION_PRESET_NAMES)("under the %s preset", (preset) => {
		// given (the same effect both inside and outside the project: under `workspace`, direct in-project
		// bash/edit is allowed but writes outside the project are asked about (config.ts:19))
		const direct = [
			decisionFor(preset, "bash", { command: "mkdir build-out" }),
			decisionFor(preset, "edit", { path: join(project, "notes.txt"), oldText: "notes", newText: "n" }),
			decisionFor(preset, "write", { path: join(project, "new.txt"), content: "x" }),
			decisionFor(preset, "write", { path: join(outsideDir, "new.txt"), content: "x" }),
			decisionFor(preset, "bash", { command: `mkdir ${join(outsideDir, "out")}` }),
		];
		const strictestDirect = Math.max(...direct.map((action) => STRICTNESS[action]));

		// when
		const evalAction = decisionFor(preset, "eval", { language: "js", code: "require('node:fs').mkdirSync('x')" });

		// then
		expect(STRICTNESS[evalAction]).toBeGreaterThanOrEqual(strictestDirect);
	});

	it.each(PERMISSION_PRESET_NAMES)(
		"under the %s preset, eval is never allowed unless every permission is allowed",
		(preset) => {
			// given
			const evalAction = decisionFor(preset, "eval", { language: "js", code: "require('node:fs').mkdirSync('x')" });
			const everythingAllowed = evaluate("*", ["*"], rulesForPreset(preset)).action === "allow";

			// then (an eval cell is arbitrary code, so only a preset that allows everything may allow it)
			expect(evalAction === "allow").toBe(everythingAllowed);
		},
	);

	it("through the real tool_call path: workspace asks for a plain eval tool", async () => {
		// given (a plain eval tool with no permissionParser of its own: the builtin parser rules on the cell)
		const evalTool: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "eval",
				label: "eval",
				description: "Return an eval receipt.",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "eval executed" }], details: {} };
				},
			});
		};

		// when (workspace allows direct in-project bash/edit, but an eval cell can do anything)
		const host = await createPermissionP0Host([evalTool]);
		try {
			const result = await host.run("workspace", { name: "eval", args: {} });

			// then
			expect(result.approvals).toHaveLength(1);
			expect(JSON.stringify(result.result)).not.toContain("eval executed");
		} finally {
			await host.dispose();
		}
	});

	it("the shared request resolver (the tool_call path and dispatch-policy.ts) always carries the eval class", () => {
		//#given: a tool named `eval` whose own permissionParser returns a `read` request. Both the
		// tool_call handler and dispatch-policy.ts (the path a cell's own tool.* calls take) go through
		// permissionRequestsFor, so this covers both call sites.
		const registry = createBuiltinParserRegistry();
		const tools: ToolInfo[] = [
			{
				name: "eval",
				label: "eval",
				description: "eval",
				parameters: Type.Object({}),
				sourceInfo: { origin: "top-level", path: "test", source: "test", scope: "temporary" },
				exposure: "direct",
				searchKeywords: [],
				allowLazyActivation: false,
				permissionParser: () => [{ permission: "read", patterns: ["*"], always: ["*"] }],
			},
		];

		//#when
		const requests = permissionRequestsFor(
			() => [...tools],
			registry,
			"eval",
			{ language: "js", code: "x" },
			project,
		);

		//#then: the narrower `read` answer is not the only request
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ permission: "read" }),
				expect.objectContaining({ permission: "eval" }),
			]),
		);
	});

	it("through the real tool_call path: an eval tool whose own permissionParser returns `read` is still asked under workspace", async () => {
		// given (a tool owned permissionParser returning a `read` request: if eval ever carries one,
		// a workspace preset that allows reads must still not approve the whole cell)
		const evalTool: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "eval",
				label: "eval",
				description: "Return an eval receipt.",
				parameters: Type.Object({}),
				permissionParser: () => [{ permission: "read", patterns: ["*"], always: ["*"] }],
				async execute() {
					return { content: [{ type: "text", text: "eval executed" }], details: {} };
				},
			});
		};

		// when
		const host = await createPermissionP0Host([evalTool]);
		try {
			const result = await host.run("workspace", { name: "eval", args: {} });

			// then
			expect(result.approvals).toHaveLength(1);
			expect(JSON.stringify(result.result)).not.toContain("eval executed");
		} finally {
			await host.dispose();
		}
	});

	it("the auto preset's judge never approves an eval cell, whatever its code", async () => {
		// given
		const cells = ["require('node:fs').mkdirSync('build-out')", "await tool.read({ path: 'notes.txt' })", "return 1"];

		// when
		const decisions = await Promise.all(
			cells.map((code) =>
				decideAuto(
					"eval",
					{ language: "js", code },
					{ permission: "eval", patterns: ["*"], always: ["*"] },
					project,
				),
			),
		);

		// then
		expect(decisions).toEqual(cells.map(() => ({ approveBlanketAsk: false })));
	});
});
