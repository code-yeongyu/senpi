import { describe, expect, it, vi } from "vitest";
import {
	resolveClaudeSettingsEnv,
	resolveQuerySettingsEnv,
} from "../../../src/core/extensions/builtin/anthropic-subscription/claude-settings-env.ts";
import { pinOneShotPromptCacheTtl } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-cache-ttl.ts";

describe("senpi#2988 a lifetime set in a loaded settings file is visible to the one-shot pin", () => {
	it.each([
		["oauth-slots", {}, {}, { FORCE_PROMPT_CACHING_5M: "1" }, "5m"],
		["oauth-slots", {}, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "5m"],
		["oauth-slots", {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "5m"],
		["oauth-slots", { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "5m"],
		["oauth-slots", { FORCE_PROMPT_CACHING_5M: "1" }, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, "5m"],
		["ambient", {}, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" }, "5m"],
		["ambient", {}, {}, { FORCE_PROMPT_CACHING_5M: "1" }, "5m"],
		["oauth-slots", {}, {}, { CLAUDE_CODE_PROMPT_CACHE_TTL: "10m" }, "1h"],
		["ambient", {}, {}, {}, undefined],
	] as const)(
		"pins %s with options env %j, process env %j and settings env %j to %s",
		(lane, optionsEnv, environment, settingsEnv, expected) => {
			// given the query options of a one-shot attempt on that lane
			const options: { env?: Record<string, string | undefined> } = { env: { ...optionsEnv } };

			// when its cache lifetime is pinned against the settings files the attempt loads
			const ttl = pinOneShotPromptCacheTtl(options, lane, environment, settingsEnv);

			// then the breakpoint uses the lifetime Claude Code will actually use
			expect(ttl).toBe(expected);
			if (expected === undefined) {
				expect(options.env).toEqual({ ...optionsEnv });
			} else {
				expect(options.env).toEqual({ ...optionsEnv, CLAUDE_CODE_PROMPT_CACHE_TTL: expected });
			}
		},
	);

	it("reads the effective env from the same settings sources the query loads", async () => {
		// given the SDK merge engine reporting a settings env
		const resolveSettings = vi.fn().mockResolvedValue({
			effective: { env: { FORCE_PROMPT_CACHING_5M: "1" } },
			provenance: {},
			sources: [],
		});

		// when the settings env for this attempt is resolved
		const env = await resolveClaudeSettingsEnv(
			{ cwd: "/work/project", settingSources: ["user", "project"] },
			resolveSettings,
		);

		// then the query's sources and cwd reach the merge engine, and the env comes back
		expect(resolveSettings).toHaveBeenCalledWith({ cwd: "/work/project", settingSources: ["user", "project"] });
		expect(env).toEqual({ FORCE_PROMPT_CACHING_5M: "1" });
	});

	it("returns undefined when the effective settings carry no env block", async () => {
		// given the SDK merge engine reporting no env block
		const resolveSettings = vi.fn().mockResolvedValue({ effective: {}, provenance: {}, sources: [] });

		// when the settings env for this attempt is resolved
		const env = await resolveClaudeSettingsEnv(
			{ cwd: "/work/project", settingSources: ["user", "project"] },
			resolveSettings,
		);

		// then there is nothing for the pin to read
		expect(env).toBeUndefined();
	});

	it("resolves to nothing when the attempt loads no settings sources", async () => {
		// given an explicit empty source list, and the default prompt mode (which
		// also loads none): no merge runs in either case
		expect(await resolveQuerySettingsEnv("/work/project", { settingSources: [] })).toBeUndefined();
		expect(await resolveQuerySettingsEnv("/work/project", {})).toBeUndefined();
	});

	it("falls back to the old pin behavior when settings resolution fails", async () => {
		// given a settings merge that throws (for example an MDM lookup failure)
		const resolveSettings = vi.fn().mockRejectedValue(new Error("plutil failed"));

		// when the settings env for this attempt is resolved
		const env = await resolveClaudeSettingsEnv(
			{ cwd: "/work/project", settingSources: ["user", "project"] },
			resolveSettings,
		);

		// then the pin proceeds as if no settings file set a lifetime, instead of failing the turn
		expect(env).toBeUndefined();
	});
});
