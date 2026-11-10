import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFallbackLogger } from "../../src/core/retry-fallback/log.ts";

// omo#12965: fallback.log generations written by an engine without the shared redaction registry are removed the
// first time an engine with it starts on that agent dir (AgentSession builds its fallback logger at construction);
// every later start leaves the logs alone.

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function agentDirWithLogs(files: Record<string, string>): { agentDir: string; logs: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-fallback-generations-"));
	dirs.push(agentDir);
	const logs = join(agentDir, "logs");
	mkdirSync(logs, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(logs, name), text);
	return { agentDir, logs };
}

describe("fallback log generations from before the shared registry", () => {
	it("removes fallback.log.1 and fallback.log on the first start", () => {
		const { agentDir, logs } = agentDirWithLogs({ "fallback.log": "earlier\n", "fallback.log.1": "rotated\n" });

		createFallbackLogger(agentDir);

		expect(existsSync(join(logs, "fallback.log.1"))).toBe(false);
		expect(existsSync(join(logs, "fallback.log"))).toBe(false);
	});

	it("leaves later generations alone on every following start", () => {
		const { agentDir, logs } = agentDirWithLogs({ "fallback.log.1": "rotated\n" });
		createFallbackLogger(agentDir);
		writeFileSync(join(logs, "fallback.log.1"), "rotated after the first start\n");
		writeFileSync(join(logs, "fallback.log"), "written after the first start\n");

		createFallbackLogger(agentDir);

		expect(readFileSync(join(logs, "fallback.log.1"), "utf8")).toBe("rotated after the first start\n");
		expect(readFileSync(join(logs, "fallback.log"), "utf8")).toBe("written after the first start\n");
	});

	it("starts cleanly on an agent dir that has no logs yet", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-fallback-generations-"));
		dirs.push(agentDir);

		const logger = createFallbackLogger(agentDir);
		logger.info("first_line", { selector: "a/one" });

		expect(readFileSync(join(agentDir, "logs", "fallback.log"), "utf8")).toContain("first_line");
	});
});
