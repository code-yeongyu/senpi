import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../src/config.ts";
import { appendHiddenTuiStdout } from "../src/core/hidden-stdout-log.ts";

const originalAgentDir = process.env[ENV_AGENT_DIR];
const githubFineGrainedPat = "github_pat_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const tempDirs: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) {
		delete process.env[ENV_AGENT_DIR];
	} else {
		process.env[ENV_AGENT_DIR] = originalAgentDir;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

describe("hidden TUI stdout log", () => {
	it("redacts hidden interactive stdout before writing the debug log", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-hidden-stdout-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		appendHiddenTuiStdout(
			[
				"SECRET_TOKEN=debug-secret",
				"Authorization: Bearer stdout-secret",
				`token ${githubFineGrainedPat}`,
				"github_pat_short",
			].join("\n"),
		);

		const debugLogPath = getDebugLogPath();
		const log = readFileSync(debugLogPath, "utf8");
		expect(log).toContain("hidden stdout while TUI active");
		expect(log).toContain("SECRET_TOKEN=[REDACTED]");
		expect(log).toContain("Authorization: Bearer [REDACTED]");
		expect(log).toContain("token [REDACTED]");
		expect(log).toContain("github_pat_short");
		expect(log).not.toContain("debug-secret");
		expect(log).not.toContain("stdout-secret");
		expect(log).not.toContain(githubFineGrainedPat);
		expect((statSync(debugLogPath).mode & 0o777).toString(8)).toBe("600");
	});

	it("ignores empty chunks", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-hidden-stdout-empty-"));
		tempDirs.push(agentDir);
		process.env[ENV_AGENT_DIR] = agentDir;

		appendHiddenTuiStdout("");

		expect(() => statSync(getDebugLogPath())).toThrow();
	});
});
