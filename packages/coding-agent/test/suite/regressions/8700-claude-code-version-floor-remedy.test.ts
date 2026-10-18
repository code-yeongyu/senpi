import { describe, expect, it } from "vitest";
import type { ClaudeCodeExecutableSource } from "../../../src/core/extensions/builtin/anthropic-subscription/executable.ts";
import { claudeCodeVersionFloorGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/guidance.ts";

const floorError =
	"API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again. (invalid_request)";

const executables: Record<ClaudeCodeExecutableSource, string> = {
	override: "/opt/claude-pinned/claude",
	bundled: "/lib/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
	path: "/home/user/.local/bin/claude",
};

function guidanceFor(source: ClaudeCodeExecutableSource): string | undefined {
	return claudeCodeVersionFloorGuidance(floorError, { executable: executables[source], source });
}

describe("regression omo#8700: the version-floor remedy follows the binary that ran", () => {
	it("names the executable that ran and the floor, for every source", () => {
		for (const source of ["override", "bundled", "path"] as const) {
			const guidance = guidanceFor(source);
			expect(guidance).toContain(executables[source]);
			expect(guidance).toContain("Claude Code 2.1.280 or newer");
		}
	});

	it("gives each source its own remedy", () => {
		const remedies = new Set((["override", "bundled", "path"] as const).map(guidanceFor));
		expect(remedies.size).toBe(3);
	});

	it("does not blame the bundled binary when CLAUDE_CODE_EXECUTABLE or PATH supplied it", () => {
		expect(guidanceFor("override")).not.toMatch(/bundled/i);
		expect(guidanceFor("path")).not.toMatch(/bundled/i);
		expect(claudeCodeVersionFloorGuidance(floorError)).not.toMatch(/bundled/i);
	});
});
