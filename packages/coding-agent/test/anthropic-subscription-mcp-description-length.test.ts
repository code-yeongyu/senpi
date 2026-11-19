import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { claudeCodeQueryEnvironment } from "../src/core/extensions/builtin/anthropic-subscription/query-environment.ts";

// oh-my-openagent#14291: senpi's tools reach Claude Code as MCP tools, and Claude Code cuts each MCP tool description
// at 4096 chars unless CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH says otherwise; the eval description alone is ~8k.
const CLAUDE_CODE_DEFAULT_MCP_DESCRIPTION_CAP = 4096;
const LONGEST_SENPI_TOOL_DESCRIPTION = 8_120;

const model: Model<Api> = {
	id: "claude-sonnet-4-6",
	name: "claude-sonnet-4-6",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("Claude Code MCP tool description length on the subscription lane", () => {
	it("lifts Claude Code's description cap above the longest senpi tool description, whoever owns compaction", () => {
		for (const senpiOwnsCompaction of [true, false]) {
			// given a host that never set the cap
			// when the lane builds the Claude Code environment
			const value = claudeCodeQueryEnvironment(model, senpiOwnsCompaction, {}).CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH;

			// then a full tool description fits instead of being cut at the default cap
			expect(Number(value)).toBeGreaterThan(CLAUDE_CODE_DEFAULT_MCP_DESCRIPTION_CAP);
			expect(Number(value)).toBeGreaterThanOrEqual(LONGEST_SENPI_TOOL_DESCRIPTION);
		}
	});

	it("leaves a cap the user set in the host environment to win", () => {
		// given a host that set its own cap
		const host = { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "2048" };

		// when the lane builds the Claude Code environment it layers over the host's
		const environment = claudeCodeQueryEnvironment(model, true, host);

		// then the lane does not override it
		expect(environment).not.toHaveProperty("CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH");
	});
});
