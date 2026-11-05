import { describe, expect, it } from "vitest";

import { resolveTtsrConfig } from "../../src/core/extensions/builtin/ttsr/settings.ts";

describe("TTSR flag and settings precedence (senpi#4621)", () => {
	it.each([
		{ name: "nothing set", flag: false, rules: "", settings: {}, disabledBy: null, disabledRules: [] },
		{ name: "only the flag", flag: true, rules: "", settings: {}, disabledBy: "flag", disabledRules: [] },
		{
			name: "only the setting",
			flag: false,
			rules: "",
			settings: { ttsr: { enabled: false } },
			disabledBy: "settings",
			disabledRules: [],
		},
		{
			name: "both, where the flag is reported",
			flag: true,
			rules: "",
			settings: { ttsr: { enabled: false } },
			disabledBy: "flag",
			disabledRules: [],
		},
		{
			name: "the flag while the setting says enabled",
			flag: true,
			rules: "",
			settings: { ttsr: { enabled: true } },
			disabledBy: "flag",
			disabledRules: [],
		},
		{
			name: "rule lists from both, merged and deduplicated",
			flag: false,
			rules: "collapse-repetition, repetitive-turns",
			settings: { ttsr: { disabledRules: ["repetitive-turns", "control-token-leak", " "] } },
			disabledBy: null,
			disabledRules: ["collapse-repetition", "repetitive-turns", "control-token-leak"],
		},
		{
			name: "a malformed section",
			flag: false,
			rules: "",
			settings: { ttsr: { enabled: "no", disabledRules: "collapse-repetition" } },
			disabledBy: null,
			disabledRules: ["collapse-repetition"],
		},
	] as const)("$name", ({ flag, rules, settings, disabledBy, disabledRules }) => {
		expect(resolveTtsrConfig(flag, rules, settings)).toEqual({ disabledBy, disabledRules });
	});
});
