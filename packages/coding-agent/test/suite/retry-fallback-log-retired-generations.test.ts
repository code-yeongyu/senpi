import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberResolvedReferenceValue } from "../../src/core/config-reference-redaction.ts";
import { createFallbackLogger } from "../../src/core/retry-fallback/log.ts";

// omo#12965: fallback.log generations written by an engine without the shared redaction registry are removed the
// first time an engine with it starts on that agent dir (AgentSession builds its fallback logger at construction);
// every later start leaves the logs alone.

const PENDING_MARKER = "pending-12965-marker-w8r2";
rememberResolvedReferenceValue(PENDING_MARKER);

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
	it("removes fallback.log.1 and fallback.log on the first start", async () => {
		const { agentDir, logs } = agentDirWithLogs({ "fallback.log": "earlier\n", "fallback.log.1": "rotated\n" });

		await createFallbackLogger(agentDir).settled();

		expect(existsSync(join(logs, "fallback.log.1"))).toBe(false);
		expect(existsSync(join(logs, "fallback.log"))).toBe(false);
	});

	it("leaves later generations alone on every following start", async () => {
		const { agentDir, logs } = agentDirWithLogs({ "fallback.log.1": "rotated\n" });
		await createFallbackLogger(agentDir).settled();
		writeFileSync(join(logs, "fallback.log.1"), "rotated after the first start\n");
		writeFileSync(join(logs, "fallback.log"), "written after the first start\n");

		await createFallbackLogger(agentDir).settled();

		expect(readFileSync(join(logs, "fallback.log.1"), "utf8")).toBe("rotated after the first start\n");
		expect(readFileSync(join(logs, "fallback.log"), "utf8")).toBe("written after the first start\n");
	});

	it("starts cleanly on an agent dir that has no logs yet", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-fallback-generations-"));
		dirs.push(agentDir);

		const logger = createFallbackLogger(agentDir);
		logger.info("first_line", { selector: "a/one" });
		await logger.settled();

		expect(readFileSync(join(agentDir, "logs", "fallback.log"), "utf8")).toContain("first_line");
	});

	it("keeps a line logged during the first-start removal, in order, after the removed generations", async () => {
		const { agentDir, logs } = agentDirWithLogs({ "fallback.log": "earlier\n", "fallback.log.1": "rotated\n" });
		const logger = createFallbackLogger(agentDir);

		logger.info("first_line", { selector: "a/one" });
		logger.info("second_line", { selector: "b/two" });
		await logger.settled();
		logger.info("third_line", { selector: "c/three" });

		const text = readFileSync(join(logs, "fallback.log"), "utf8");
		expect(text).not.toContain("earlier");
		expect(existsSync(join(logs, "fallback.log.1"))).toBe(false);
		const events = text
			.trimEnd()
			.split("\n")
			.map((line) => (JSON.parse(line) as { event: string }).event);
		expect(events).toEqual(["first_line", "second_line", "third_line"]);
	});

	it("redacts a secret logged during the pending window before it is queued", async () => {
		const { agentDir, logs } = agentDirWithLogs({});
		const logger = createFallbackLogger(agentDir);

		logger.warn("candidate_failed", { errorMessage: `echo ${PENDING_MARKER}` });
		await logger.settled();

		const text = readFileSync(join(logs, "fallback.log"), "utf8");
		expect(text).toContain("[redacted]");
		expect(text).not.toContain(PENDING_MARKER);
	});

	it("bounds the pending queue, keeps the newest lines and counts the drops", async () => {
		const { agentDir, logs } = agentDirWithLogs({});
		const logger = createFallbackLogger(agentDir);

		for (let i = 0; i < 300; i += 1) logger.info("burst", { selector: `m/${i}` });
		await logger.settled();

		const lines = readFileSync(join(logs, "fallback.log"), "utf8").trimEnd().split("\n");
		const entries = lines.map((line) => JSON.parse(line) as { event: string; selector?: string; reason?: string });
		expect(entries.filter((entry) => entry.event === "burst")).toHaveLength(256);
		expect(entries.find((entry) => entry.event === "burst")?.selector).toBe("m/44");
		expect(entries.at(-1)).toMatchObject({ event: "queued_lines_dropped" });
		expect(entries.at(-1)?.reason).toContain("44 lines");
	});

	it("keeps logging and reports one redacted warning when the removal fails", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-fallback-generations-"));
		dirs.push(agentDir);
		const logs = join(agentDir, "logs");
		mkdirSync(join(logs, "fallback.log.1", "blocked"), { recursive: true });
		writeFileSync(join(logs, "fallback.log.1", "blocked", "keep"), "x");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createFallbackLogger(agentDir);

		logger.info("still_logged", { selector: "a/one" });
		await logger.settled();
		error.mockRestore();

		const events = readFileSync(join(logs, "fallback.log"), "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => (JSON.parse(line) as { event: string }).event);
		expect(events).toEqual(["still_logged", "retire_generations_failed"]);
	});
});
