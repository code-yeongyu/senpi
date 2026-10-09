import { describe, expect, it } from "vitest";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import type { Request } from "../../src/core/extensions/builtin/permission-system/types.ts";

function createRequest(overrides: Partial<Request> = {}): Request {
	return {
		id: overrides.id ?? "request-1",
		sessionID: overrides.sessionID ?? "session-1",
		permission: overrides.permission ?? "bash",
		patterns: overrides.patterns ?? ["git status"],
		always: overrides.always ?? ["*"],
		metadata: overrides.metadata ?? {},
		tool: overrides.tool,
	};
}

describe("permission presets", () => {
	// senpi#2430: project edits must not silently approve shell execution.
	it.each([
		["bash", "git status", "ask"],
		["edit", "src/index.ts", "allow"],
		["read", "README.md", "allow"],
		["list", "src", "allow"],
		["grep", "src", "allow"],
		["unknown_tool", "*", "ask"],
	] as const)("accept-edits evaluates %s as %s", (permission, pattern, action) => {
		// given: earlier unrestricted rules must not weaken the new preset.
		const ruleset = [...rulesForPreset("full-access"), ...rulesForPreset("accept-edits")];
		// when
		const result = evaluate(permission, pattern, ruleset);
		// then
		expect(result.action).toBe(action);
	});

	it("asks before an outside write under accept-edits", () => {
		// given
		const registry = createBuiltinParserRegistry();
		const ruleset = rulesForPreset("accept-edits");
		// when: a write is an edit plus an independent external-directory grant.
		const requests = registry.parse("write", { path: "../outside.txt", content: "hello" }, "/tmp/project");
		// then
		expect(requests.some((request) => request.permission === "external_directory")).toBe(true);
		expect(
			requests.flatMap((request) =>
				request.patterns.map((pattern) => evaluate(request.permission, pattern, ruleset).action),
			),
		).toContain("ask");
	});

	it("allows a project edit without an external-directory request", () => {
		// given
		const registry = createBuiltinParserRegistry();
		const ruleset = rulesForPreset("accept-edits");
		// when
		const requests = registry.parse("edit", { path: "src/index.ts", oldText: "old", newText: "new" }, "/tmp/project");
		// then
		expect(requests.map((request) => request.permission)).toEqual(["edit"]);
		expect(
			requests.flatMap((request) =>
				request.patterns.map((pattern) => evaluate(request.permission, pattern, ruleset).action),
			),
		).toEqual(["allow"]);
	});

	it("overrides an earlier full-access preset with workspace ask boundaries", () => {
		// given
		const ruleset = [...rulesForPreset("full-access"), ...rulesForPreset("workspace")];

		// when/then
		expect(evaluate("bash", "git status", ruleset).action).toBe("allow");
		expect(evaluate("external_directory", "../outside", ruleset).action).toBe("ask");
		expect(evaluate("unknown_tool", "*", ruleset).action).toBe("ask");
	});

	it("overrides an earlier full-access preset with read-only ask boundaries", () => {
		// given
		const ruleset = [...rulesForPreset("full-access"), ...rulesForPreset("read-only")];

		// when/then
		expect(evaluate("read", "README.md", ruleset).action).toBe("allow");
		expect(evaluate("bash", "git status", ruleset).action).toBe("ask");
		expect(evaluate("edit", "src/index.ts", ruleset).action).toBe("ask");
		expect(evaluate("unknown_tool", "*", ruleset).action).toBe("ask");
	});

	it("rejects no-UI requests when a preset still requires confirmation", () => {
		// given
		const events: Array<{ event: string; data: unknown }> = [];

		// when
		const result = handleNoUI(createRequest(), {
			emitEvent: (event, data) => {
				events.push({ event, data });
			},
		});

		// then
		expect(result).toEqual({
			requestID: "request-1",
			reply: "reject",
			message: "Permission required for bash (git status). Use --permission bash=allow to override.",
		});
		expect(events.map((event) => event.event)).toEqual(["permission_asked"]);
	});
});
