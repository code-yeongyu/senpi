import { afterEach, describe, expect, it, vi } from "vitest";

import { type CompactionLoggerData, createCompactionLogger } from "../../src/core/extensions/builtin/compaction/log.ts";

describe("compaction logger", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("Given disabled mirror env When logging Then it stays silent on stderr and writes JSONL", () => {
		const dir = "/tmp/senpi-compaction-log-disabled";
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
		const dir = "/tmp/senpi-compaction-log-rotate";
		const sink: string[] = [];
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line), maxBytes: 1 });

		logger.info("skip_cap", { count: 1 });
		logger.info("skip_breaker", { count: 2 });

		expect(sink).toHaveLength(2);
		expect(JSON.parse(sink[0] as string)).toMatchObject({ event: "skip_cap", level: "info" });
		expect(JSON.parse(sink[1] as string)).toMatchObject({ event: "skip_breaker", level: "info" });
	});

	it("Given debug env When logging Then it mirrors to stderr", () => {
		const dir = "/tmp/senpi-compaction-log-debug";
		vi.stubEnv("SENPI_COMPACTION_DEBUG", "1");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createCompactionLogger(dir);

		logger.debug("warm_consumed", { message: "nope" } as unknown as CompactionLoggerData);

		expect(error).toHaveBeenCalledWith("[senpi-compaction]", expect.stringContaining('"event":"warm_consumed"'));
	});

	it("Given circular data When logging Then it never throws", () => {
		const dir = "/tmp/senpi-compaction-log-circular";
		const logger = createCompactionLogger(dir, { sink: () => {} });
		const circular: Record<string, unknown> = { origin: "blocking" };
		circular.reason = circular;

		expect(() => logger.info("summary_failed", circular)).not.toThrow();
	});

	it("Given disallowed fields When logging Then only allowlisted data is emitted", () => {
		const dir = "/tmp/senpi-compaction-log-allowlist";
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
		const dir = "/tmp/senpi-compaction-log-idle";
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
});
