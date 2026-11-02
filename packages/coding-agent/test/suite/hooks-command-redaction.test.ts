import { afterEach, describe, expect, it } from "vitest";
import { formatHookDiagnostics } from "../../src/core/extensions/builtin/hooks/command.ts";
import { cleanupHooksCommandHarnesses, createHooksCommandHarness, lastNotification } from "./hooks-command-harness.ts";

// Built from parts so no credential-shaped literal sits in the source for secret scanners (senpi#5308).
const GITHUB_CLASSIC_PAT = ["ghp", "0123456789abcdef0123456789abcdef0123"].join("_");
const GITHUB_FINE_GRAINED_PAT = ["github_pat", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"].join(
	"_",
);

afterEach(() => {
	cleanupHooksCommandHarnesses();
});

describe("builtin hooks command redaction", () => {
	it("redacts GitHub PATs in hook list output without over-redacting short fragments", async () => {
		const setup = await createHooksCommandHarness({
			projectHooks: {
				hooks: {
					PreToolUse: [
						{
							matcher: `Bash ${GITHUB_CLASSIC_PAT} ghp_short`,
							hooks: [
								{
									type: "command",
									command: `node hooks/pre-tool.mjs ${GITHUB_CLASSIC_PAT} ${GITHUB_FINE_GRAINED_PAT} ghp_short github_pat_short`,
									statusMessage: `checking ${GITHUB_FINE_GRAINED_PAT} github_pat_short`,
								},
							],
						},
					],
				},
			},
		});

		await setup.harness.session.prompt("/hooks list");

		const message = lastNotification(setup.notifications).message;
		expect(message).toContain("command:node hooks/pre-tool.mjs [redacted] [redacted] ghp_short github_pat_short");
		expect(message).toContain("matcher:Bash [redacted] ghp_short");
		expect(message).toContain("statusMessage:checking [redacted] github_pat_short");
		expect(message).not.toContain(GITHUB_CLASSIC_PAT);
		expect(message).not.toContain(GITHUB_FINE_GRAINED_PAT);
		expect(setup.payloads).toEqual([]);
	});

	it("redacts GitHub PATs in hook diagnostics without changing short fragments", () => {
		const message = formatHookDiagnostics([
			{
				code: "invalid_command_target",
				event: "PreToolUse",
				message: `target ${GITHUB_CLASSIC_PAT} ${GITHUB_FINE_GRAINED_PAT} ghp_short github_pat_short`,
				path: "hooks.PreToolUse[0].hooks[0].command",
				severity: "error",
				source: {
					discoveredAt: "pre-session",
					displayOrder: 0,
					scope: "project",
					sourcePath: `/repo/${GITHUB_CLASSIC_PAT}/hooks.json`,
				},
			},
		]);

		expect(message).toContain("target [redacted] [redacted] ghp_short github_pat_short");
		expect(message).toContain("/repo/[redacted]/hooks.json");
		expect(message).not.toContain(GITHUB_CLASSIC_PAT);
		expect(message).not.toContain(GITHUB_FINE_GRAINED_PAT);
	});
});
