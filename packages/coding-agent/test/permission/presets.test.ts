import { describe, expect, it } from "vitest";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { handleNoUI } from "../../src/core/extensions/builtin/permission-system/non-interactive.ts";
import type { Request, Ruleset } from "../../src/core/extensions/builtin/permission-system/types.ts";

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

	it("allows no-UI requests with full-access", () => {
		// given
		const events: Array<{ event: string; data: unknown }> = [];

		// when
		const result = handleNoUI(createRequest(), rulesForPreset("full-access"), [], (event, data) => {
			events.push({ event, data });
		});

		// then
		expect(result).toBeUndefined();
		expect(events.map((event) => event.event)).toEqual(["permission_asked", "permission_replied"]);
	});

	it("rejects no-UI requests when a preset still requires confirmation", () => {
		// given
		const events: Array<{ event: string; data: unknown }> = [];
		const staticRuleset: Ruleset = rulesForPreset("read-only");

		// when
		const result = handleNoUI(createRequest(), staticRuleset, [], (event, data) => {
			events.push({ event, data });
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
