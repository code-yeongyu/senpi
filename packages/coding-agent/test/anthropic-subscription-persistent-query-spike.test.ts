import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SPIKE = join(
	__dirname,
	"../../../.agents/skills/senpi-qa/scripts/anthropic-subscription-persistent-query-spike.mjs",
);

describe("claude-sdk-oauth live persistent query spike", () => {
	it("is skipped by default and never touches credentials", () => {
		const output = execFileSync(process.execPath, [SPIKE], {
			env: { PATH: process.env.PATH },
			encoding: "utf8",
		});
		expect(output).toContain("SKIPPED");
	});

	it.runIf(process.env.SENPI_LIVE_CLAUDE_SDK_OAUTH === "1")(
		"accepts denial recovery, subprocess cleanup, and replay uuid correlation",
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
			expect(output).toContain("ACCEPTED denial=ok orphan=none replay=uuid-match");
		},
	);
});
