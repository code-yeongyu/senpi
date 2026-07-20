import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFallbackLogger } from "../../src/core/retry-fallback/log.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-retry-fallback-log-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("retry fallback logger", () => {
	it("writes parseable 0600 NDJSON and safely serializes malformed data", () => {
		const agentDir = createTempDir();
		const circular: { count?: bigint; self?: unknown } = { count: 1n };
		circular.self = circular;
		const logger = createFallbackLogger(agentDir);

		expect(() =>
			logger.debug("candidate_skipped", {
				selector: "ccapi/kimi-k3:max",
				error: circular,
				missing: undefined,
			}),
		).not.toThrow();

		const logPath = join(agentDir, "logs", "fallback.log");
		const entry: Record<string, unknown> = JSON.parse(readFileSync(logPath, "utf8"));
		expect(entry).toMatchObject({
			level: "debug",
			event: "candidate_skipped",
			selector: "ccapi/kimi-k3:max",
			error: { count: "1", self: "[Circular]" },
		});
		expect(entry.ts).toEqual(expect.any(String));
		expect(entry).not.toHaveProperty("missing");
		expect(statSync(logPath).mode & 0o777).toBe(0o600);
	});

	it("truncates external error text and omits credential-bearing fields", () => {
		const agentDir = createTempDir();
		const logger = createFallbackLogger(agentDir);
		const longError = "x".repeat(240);

		logger.warn("candidate_failed", {
			error: longError,
			errorMessage: "Authorization: Bearer should-not-appear",
			headers: { authorization: "Bearer should-not-appear" },
			apiKey: "should-not-appear",
			env: { SECRET: "should-not-appear" },
		});

		const text = readFileSync(join(agentDir, "logs", "fallback.log"), "utf8");
		const entry: Record<string, unknown> = JSON.parse(text);
		expect(entry.error).toBe(`${"x".repeat(197)}...`);
		expect(entry.errorMessage).toBe("Authorization: Bearer [redacted]");
		expect(text).not.toContain("should-not-appear");
		expect(entry).not.toHaveProperty("headers");
		expect(entry).not.toHaveProperty("apiKey");
		expect(entry).not.toHaveProperty("env");
	});

	it("rotates once the next line would exceed the configured cap", () => {
		const agentDir = createTempDir();
		const logger = createFallbackLogger(agentDir, { maxBytes: 150 });

		logger.info("first", { selector: "a/one" });
		logger.info("second", { selector: "b/two" });

		const logPath = join(agentDir, "logs", "fallback.log");
		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(`${logPath}.1`, "utf8")).toContain('"event":"first"');
		expect(readFileSync(logPath, "utf8")).toContain('"event":"second"');
	});

	it("never throws and reports a filesystem failure only once", () => {
		const agentDir = createTempDir();
		writeFileSync(join(agentDir, "logs"), "not a directory");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createFallbackLogger(agentDir);

		expect(() => {
			logger.info("write_failed", { selector: "a/one" });
			logger.warn("still_safe", { selector: "b/two" });
		}).not.toThrow();
		expect(error).toHaveBeenCalledTimes(1);
	});
});
