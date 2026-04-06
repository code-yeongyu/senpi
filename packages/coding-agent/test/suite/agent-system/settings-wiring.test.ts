import { describe, expect, it } from "vitest";
import { evaluate, fromConfig, merge } from "../../../src/core/extensions/builtin/agent-system/permission.js";
import type { Ruleset } from "../../../src/core/extensions/builtin/agent-system/types.js";

describe("Settings wiring into agent permission resolution", () => {
	it("applies global default when agent has no explicit rule for that permission", () => {
		// given
		const globalDefaults = fromConfig({ edit: "ask" });
		const agentPermission: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
		const merged = merge(globalDefaults, agentPermission);

		// when
		const result = evaluate("edit", "*", merged);

		// then
		expect(result.action).toBe("ask");
	});

	it("agent-specific permission overrides global default for the same permission", () => {
		// given
		const globalDefaults = fromConfig({ edit: "ask" });
		const agentPermission = fromConfig({ edit: "allow" });
		const merged = merge(globalDefaults, agentPermission);

		// when
		const result = evaluate("edit", "*", merged);

		// then
		expect(result.action).toBe("allow");
	});

	it("leaves agent permissions unchanged when no global defaults exist", () => {
		// given
		const globalDefaults = fromConfig({});
		const agentPermission = fromConfig({ bash: "allow", edit: "deny" });
		const merged = merge(globalDefaults, agentPermission);

		// when
		const bashResult = evaluate("bash", "*", merged);
		const editResult = evaluate("edit", "*", merged);

		// then
		expect(bashResult.action).toBe("allow");
		expect(editResult.action).toBe("deny");
	});

	it("global defaults provide base restrictions across multiple permissions", () => {
		// given
		const globalDefaults = fromConfig({ edit: "ask", write: "deny" });
		const agentPermission = fromConfig({ bash: "allow" });
		const merged = merge(globalDefaults, agentPermission);

		// when
		const editResult = evaluate("edit", "*", merged);
		const writeResult = evaluate("write", "*", merged);
		const bashResult = evaluate("bash", "*", merged);

		// then
		expect(editResult.action).toBe("ask");
		expect(writeResult.action).toBe("deny");
		expect(bashResult.action).toBe("allow");
	});

	it("falls back to ask when neither global defaults nor agent define a permission", () => {
		// given
		const globalDefaults = fromConfig({ edit: "ask" });
		const agentPermission = fromConfig({ bash: "allow" });
		const merged = merge(globalDefaults, agentPermission);

		// when
		const result = evaluate("write", "*", merged);

		// then
		expect(result.action).toBe("ask");
	});
});
