import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionLoggerData,
	createCompactionLogger,
	flushCompactionLogs,
} from "../../src/core/extensions/builtin/compaction/log.ts";
import { createTempAgentDir } from "../support/temp-agent-dir.ts";

describe("compaction logger", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("Given disabled mirror env When logging Then it stays silent on stderr and writes JSONL", () => {
		const dir = createTempAgentDir("senpi-compaction-log-disabled-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const sink: string[] = [];
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line), mirrorToStderr: false });

		logger.info("speculative_started", { reason: "threshold", requestId: "req-1" });

		expect(error).not.toHaveBeenCalled();
		expect(sink).toHaveLength(1);
		const entry = JSON.parse(sink[0] as string) as {
			event: string;
			level: string;
			reason?: string;
			requestId?: string;
		};
		expect(entry).toMatchObject({
			event: "speculative_started",
			level: "info",
			reason: "threshold",
			requestId: "req-1",
		});
	});

	it("Given a writable log file When logging Then it rotates past the maxBytes override", () => {
		const dir = createTempAgentDir("senpi-compaction-log-rotate-");
		const sink: string[] = [];
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line), maxBytes: 1 });

		logger.info("skip_cap", { count: 1 });
		logger.info("skip_breaker", { count: 2 });

		expect(sink).toHaveLength(2);
		expect(JSON.parse(sink[0] as string)).toMatchObject({ event: "skip_cap", level: "info" });
		expect(JSON.parse(sink[1] as string)).toMatchObject({ event: "skip_breaker", level: "info" });
	});

	it("Given debug env When logging Then it mirrors to stderr", () => {
		const dir = createTempAgentDir("senpi-compaction-log-debug-");
		vi.stubEnv("SENPI_COMPACTION_DEBUG", "1");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createCompactionLogger(dir);

		logger.debug("warm_consumed", { message: "nope" } as unknown as CompactionLoggerData);

		expect(error).toHaveBeenCalledWith("[senpi-compaction]", expect.stringContaining('"event":"warm_consumed"'));
	});

	it("Given circular data When logging Then it never throws", () => {
		const dir = createTempAgentDir("senpi-compaction-log-circular-");
		const logger = createCompactionLogger(dir, { sink: () => {} });
		const circular: Record<string, unknown> = { origin: "blocking" };
		circular.reason = circular;

		expect(() => logger.info("summary_failed", circular)).not.toThrow();
	});

	it("Given disallowed fields When logging Then only allowlisted data is emitted", () => {
		const dir = createTempAgentDir("senpi-compaction-log-allowlist-");
		const sink: string[] = [];
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line) });

		logger.info("threshold_trigger", {
			origin: "speculative",
			reason: "threshold",
			message: "do not include",
			summary: "nope",
			tokens: 42,
		} as unknown as CompactionLoggerData);

		const entry = JSON.parse(sink[0] as string) as Record<string, unknown>;
		expect(entry).toMatchObject({
			event: "threshold_trigger",
			level: "info",
			origin: "speculative",
			reason: "threshold",
			tokens: 42,
		});
		expect(entry).not.toHaveProperty("message");
		expect(entry).not.toHaveProperty("summary");
	});

	it("Given the idle warm-up trigger When logging Then the idle_trigger event is emitted", () => {
		const dir = createTempAgentDir("senpi-compaction-log-idle-");
		const sink: string[] = [];
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line), mirrorToStderr: false });

		logger.debug("idle_trigger", { contextWindow: 100_000, tokens: 80_000 });

		expect(sink).toHaveLength(1);
		expect(JSON.parse(sink[0] as string)).toMatchObject({
			event: "idle_trigger",
			level: "debug",
			contextWindow: 100_000,
			tokens: 80_000,
		});
	});

	it("Given a burst of events while a write is in flight When it settles Then every line is on disk in order", async () => {
		const dir = createTempAgentDir("senpi-compaction-log-burst-");
		const logger = createCompactionLogger(dir);

		for (let index = 0; index < 200; index++) logger.info("skip_cap", { count: index });
		await flushCompactionLogs();

		const lines = readFileSync(join(dir, "logs", "compaction.log"), "utf8")
			.trim()
			.split("\n");
		expect(lines.map((line) => (JSON.parse(line) as { count: number }).count)).toEqual(
			Array.from({ length: 200 }, (_, index) => index),
		);
	});

	// senpi#2778: two sessions may write identical generations to the same log.
	it("attributes interleaved events to their session at emission time", async () => {
		const dir = createTempAgentDir("senpi-compaction-log-sessions-");
		let firstSession = "session-a";
		const first = createCompactionLogger(dir, { getSessionId: () => firstSession, mirrorToStderr: false });
		const second = createCompactionLogger(dir, { getSessionId: () => "session-b", mirrorToStderr: false });
		first.info("blocking_started", { generation: 34 });
		second.info("blocking_started", { generation: 34 });
		first.info("speculative_stale", { generation: 34 });
		firstSession = "session-c";
		first.info("blocking_started", { generation: 1 });
		await flushCompactionLogs();

		const entries = readFileSync(join(dir, "logs", "compaction.log"), "utf8")
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line));
		expect(entries.map(({ event, sessionId }) => [event, sessionId])).toEqual([
			["blocking_started", "session-a"],
			["blocking_started", "session-b"],
			["speculative_stale", "session-a"],
			["blocking_started", "session-c"],
		]);
	});

	it("Given a burst larger than the size cap When it settles Then neither file holds more than one cap of lines and the newest lines are kept", async () => {
		const dir = createTempAgentDir("senpi-compaction-log-burst-rotate-");
		const maxBytes = 400;
		const logger = createCompactionLogger(dir, { maxBytes });

		for (let index = 0; index < 60; index++) logger.info("skip_cap", { count: index });
		await flushCompactionLogs();

		const current = readFileSync(join(dir, "logs", "compaction.log"), "utf8");
		const previous = readFileSync(join(dir, "logs", "compaction.log.1"), "utf8");
		expect(Buffer.byteLength(current)).toBeLessThanOrEqual(maxBytes);
		expect(Buffer.byteLength(previous)).toBeLessThanOrEqual(maxBytes);
		const counts = (text: string) =>
			text
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { count: number }).count);
		const kept = [...counts(previous), ...counts(current)];
		expect(kept.at(-1)).toBe(59);
		expect(kept).toEqual([...kept].sort((a, b) => a - b));
	});

	it("Given an unwritable log directory When logging Then the caller never throws and later lines still go to the sink", async () => {
		const dir = createTempAgentDir("senpi-compaction-log-unwritable-");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const sink: string[] = [];
		const logger = createCompactionLogger(join(dir, "\0invalid"), { sink: (line) => sink.push(line) });

		expect(() => logger.info("skip_cap", { count: 1 })).not.toThrow();
		await flushCompactionLogs();
		logger.info("skip_breaker", { count: 2 });

		expect(sink).toHaveLength(2);
		expect(error).toHaveBeenCalledWith("Unable to write compaction log", expect.anything());
	});
});
