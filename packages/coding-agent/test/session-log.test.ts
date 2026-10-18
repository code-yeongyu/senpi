import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionLogger } from "../src/core/session-log.ts";

const tempDirs: string[] = [];

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-session-log-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function readLines(agentDir: string): Array<Record<string, unknown>> {
	const raw = readFileSync(join(agentDir, "logs", "session.log"), "utf-8").trim();
	return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("createSessionLogger", () => {
	it("writes JSONL lines with ts, level, and event to logs/session.log", () => {
		const agentDir = makeAgentDir();
		const logger = createSessionLogger(agentDir);

		logger.info("compaction_queue_flush_result", { count: 2, willRetry: false, delivered: 2, restored: 0 });

		const lines = readLines(agentDir);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: "info",
			event: "compaction_queue_flush_result",
			count: 2,
			willRetry: false,
			delivered: 2,
			restored: 0,
		});
		expect(typeof lines[0]?.ts).toBe("string");
	});

	it("drops non-allowlisted and secret-bearing data keys", () => {
		const agentDir = makeAgentDir();
		const logger = createSessionLogger(agentDir);

		logger.warn("prompt_rejected", {
			error: "RequiredCompactionError",
			stage: "admission",
			authorization: "Bearer sk-live-secret",
			headers: { cookie: "a=b" },
			messageText: "the user's private prompt",
		});

		const [line] = readLines(agentDir);
		expect(line).toMatchObject({ event: "prompt_rejected", error: "RequiredCompactionError", stage: "admission" });
		expect(line).not.toHaveProperty("authorization");
		expect(line).not.toHaveProperty("headers");
		expect(line).not.toHaveProperty("messageText");
	});

	it("keeps the session id so lines from concurrent sessions can be attributed", () => {
		const agentDir = makeAgentDir();
		const logger = createSessionLogger(agentDir);

		logger.info("claude_sdk_oauth_session_continuity", { kind: "delta", sessionId: "01a0-session" });

		expect(readLines(agentDir)[0]).toMatchObject({ kind: "delta", sessionId: "01a0-session" });
	});

	it("redacts bearer tokens embedded in allow-listed string values", () => {
		const agentDir = makeAgentDir();
		const logger = createSessionLogger(agentDir);

		logger.warn("provider_error", { error: "authorization: Bearer sk-live-abc123 rejected" });

		const [line] = readLines(agentDir);
		expect(String(line?.error)).not.toContain("sk-live-abc123");
		expect(String(line?.error)).toContain("[redacted]");
	});

	it("rotates the log once it exceeds maxBytes", () => {
		const agentDir = makeAgentDir();
		const logger = createSessionLogger(agentDir, { maxBytes: 300 });

		for (let i = 0; i < 10; i++) {
			logger.info("stream_stall", { kind: "idle", durationMs: 300_000 });
		}

		const rotated = statSync(join(agentDir, "logs", "session.log.1"));
		expect(rotated.size).toBeGreaterThan(0);
		expect(statSync(join(agentDir, "logs", "session.log")).size).toBeLessThanOrEqual(300);
	});

	it("is a no-op without an agentDir and never throws on write failures", () => {
		const noopLogger = createSessionLogger(undefined);
		expect(() => noopLogger.info("config_reload", { phase: "deferred" })).not.toThrow();

		const agentDir = makeAgentDir();
		writeFileSync(join(agentDir, "logs"), "not a directory");
		const blockedLogger = createSessionLogger(agentDir);
		expect(() => blockedLogger.info("config_reload", { phase: "deferred" })).not.toThrow();
	});

	it("mirrors lines to an injected sink", () => {
		const agentDir = makeAgentDir();
		const sinkLines: string[] = [];
		const logger = createSessionLogger(agentDir, { sink: (line) => sinkLines.push(line) });

		logger.debug("clipboard_error", { op: "read-image", error: "permission denied", durationMs: 12 });

		expect(sinkLines).toHaveLength(1);
		expect(JSON.parse(sinkLines[0] ?? "{}")).toMatchObject({ event: "clipboard_error", op: "read-image" });
	});
});
