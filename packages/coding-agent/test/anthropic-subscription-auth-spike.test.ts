import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SPIKES_DIR = join(__dirname, "../../../.agents/skills/senpi-qa/scripts");
const spike = (name: string) => join(SPIKES_DIR, `anthropic-subscription-${name}-spike.mjs`);
const SPIKE = spike("auth");

describe("claude-sdk-oauth live spikes", () => {
	// Every live spike must exit early unless SENPI_LIVE_CLAUDE_SDK_OAUTH=1, so a default run never touches credentials.
	it.each(["auth", "autocompact", "native-inline", "persistent-query", "reattach", "sysprompt"])(
		"%s spike is skipped by default and never touches credentials",
		(name) => {
			const output = execFileSync(process.execPath, [spike(name)], {
				env: { PATH: process.env.PATH },
				encoding: "utf8",
			});
			expect(output).toContain("SKIPPED");
		},
	);
});

describe("claude-sdk-oauth live auth spike", () => {
	it.runIf(process.env.SENPI_LIVE_CLAUDE_SDK_OAUTH === "1")(
		"accepts one multi-account lane against the seeded sandbox",
		() => {
			const sandbox = process.env.SENPI_CODING_AGENT_DIR;
			expect(sandbox, "SENPI_CODING_AGENT_DIR must point at the seeded sandbox").toBeTruthy();
			const output = execFileSync(process.execPath, [SPIKE], {
				env: {
					PATH: process.env.PATH,
					SENPI_LIVE_CLAUDE_SDK_OAUTH: "1",
					SENPI_CODING_AGENT_DIR: sandbox as string,
				},
				encoding: "utf8",
			});
			expect(output).toMatch(/ACCEPTED lane=(oauth-slots|config-dir)/);
		},
	);
});
