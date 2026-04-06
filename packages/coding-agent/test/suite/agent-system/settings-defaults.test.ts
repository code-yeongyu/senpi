import { describe, expect, it } from "vitest";
import { fromConfig } from "../../../src/core/extensions/builtin/agent-system/permission.js";
import type { Settings } from "../../../src/core/settings-manager.js";

describe("AgentDefaultsSettings", () => {
	describe("fromConfig with settings.agentDefaults.permission", () => {
		it("produces valid Ruleset from agentDefaults permission config", () => {
			// given
			const settings: Settings = {
				agentDefaults: {
					permission: { bash: "allow", edit: "deny" },
				},
			};

			// when
			const ruleset = fromConfig(settings.agentDefaults?.permission ?? {});

			// then
			expect(ruleset).toEqual([
				{ permission: "bash", pattern: "*", action: "allow" },
				{ permission: "edit", pattern: "*", action: "deny" },
			]);
		});

		it("returns empty ruleset when agentDefaults is missing", () => {
			// given
			const settings: Settings = {};

			// when
			const ruleset = fromConfig(settings.agentDefaults?.permission ?? {});

			// then
			expect(ruleset).toEqual([]);
		});

		it("produces rule with wildcard pattern for single permission entry", () => {
			// given
			const settings: Settings = {
				agentDefaults: {
					permission: { edit: "ask" },
				},
			};

			// when
			const ruleset = fromConfig(settings.agentDefaults?.permission ?? {});

			// then
			expect(ruleset).toEqual([{ permission: "edit", pattern: "*", action: "ask" }]);
		});
	});

	describe("agentDefaults.model", () => {
		it("stores model string in settings", () => {
			// given
			const settings: Settings = {
				agentDefaults: {
					model: "anthropic/claude-sonnet-4-20250514",
				},
			};

			// when
			const model = settings.agentDefaults?.model;

			// then
			expect(model).toBe("anthropic/claude-sonnet-4-20250514");
		});

		it("returns undefined when agentDefaults is missing", () => {
			// given
			const settings: Settings = {};

			// when
			const model = settings.agentDefaults?.model;

			// then
			expect(model).toBeUndefined();
		});
	});
});
