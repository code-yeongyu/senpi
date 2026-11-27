import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { rememberResolvedReferenceValue } from "../../../src/core/config-reference-redaction.ts";
import { createCompactionLogger, flushCompactionLogs } from "../../../src/core/extensions/builtin/compaction/log.ts";
import { createConfigReloadLogger } from "../../../src/core/extensions/builtin/config-reload/log.ts";
import {
	flushGuardLog,
	guardLogPath,
	logGuardEvent,
} from "../../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";
import { createFallbackLogger } from "../../../src/core/retry-fallback/log.ts";
import { createSessionLogger } from "../../../src/core/session-log.ts";

// senpi#6337: a value a config reference resolved to reaches a log writer's free-text fields (an error, a reason, a
// cause, JSON details). Each writer must run its text through the resolved-value pass before the line reaches disk,
// a sink or stderr. The value is assembled at runtime so no credential-shaped literal sits in the repository, and it
// has no shape the pattern rules know: only the registry can catch it.

const root = mkdtempSync(join(tmpdir(), "senpi-6337-"));

const RESOLVED = ["plain", "resolved", "7".repeat(6), "value"].join("~");
const LONG_PREFIX = "x".repeat(190);
rememberResolvedReferenceValue(RESOLVED);

function written(file: string): string {
	return readFileSync(file, "utf8");
}

function expectRedacted(text: string): void {
	expect(text.length).toBeGreaterThan(0);
	expect(text).not.toContain(RESOLVED);
	expect(text).not.toContain(RESOLVED.slice(0, 7));
	expect(text).toContain("[redacted]");
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(guardLogPath(), { force: true });
});

describe("log writers redact registered resolved values (senpi#6337)", () => {
	it("session.log: error, reason, cause and rejectionCause, in the file, the sink and the stderr mirror", () => {
		const dir = join(root, "session");
		const sink: string[] = [];
		const mirror = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createSessionLogger(dir, { sink: (line) => sink.push(line), mirrorToStderr: true });

		logger.warn("provider_failed", {
			error: `request failed: upstream echoed ${RESOLVED}`,
			reason: `rejected ${RESOLVED}`,
			cause: JSON.stringify({ detail: RESOLVED }),
			rejectionCause: `${LONG_PREFIX}${RESOLVED}`,
		});

		const file = written(join(dir, "logs", "session.log"));
		expectRedacted(file);
		expectRedacted(sink.join("\n"));
		expectRedacted(mirror.mock.calls.flat().join(" "));
		const entry = JSON.parse(file.trim()) as Record<string, string>;
		expect(entry.error).toBe("request failed: upstream echoed [redacted]");
	});

	it("moved-path-guard.log: JSON details", async () => {
		logGuardEvent("warn", "breadcrumb_ignored", {
			reason: `breadcrumb named ${RESOLVED}`,
			path: `/tmp/${RESOLVED}/moved`,
		});
		await flushGuardLog();

		expectRedacted(written(guardLogPath()));
	});

	it("config-reload.log: reasons and watcher error messages from config text", () => {
		const dir = join(root, "config-reload");
		const logger = createConfigReloadLogger(dir);

		logger.info("reload_requested", { reason: `settings changed: apiKey "${RESOLVED}"`, paths: [] });
		logger.warn("reload_deferred", { reason: `${LONG_PREFIX}${RESOLVED}` });
		logger.error("watcher_error", { path: join(dir, "settings.json"), message: `bad value ${RESOLVED}` });

		const file = written(join(dir, "logs", "config-reload.log"));
		expectRedacted(file);
		expect(file.trim().split("\n")).toHaveLength(3);
	});

	it("compaction.log: origin, reason, route and variant, in the file, the sink and the stderr mirror", async () => {
		const dir = join(root, "compaction");
		const sink: string[] = [];
		const mirror = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createCompactionLogger(dir, { sink: (line) => sink.push(line), mirrorToStderr: true });

		logger.info("summary_failed", {
			origin: `summary text quoting ${RESOLVED}`,
			reason: `provider said ${RESOLVED}`,
			route: RESOLVED,
			variant: RESOLVED,
		});
		await flushCompactionLogs();

		expectRedacted(written(join(dir, "logs", "compaction.log")));
		expectRedacted(sink.join("\n"));
		expectRedacted(mirror.mock.calls.flat().join(" "));
	});

	it("fallback.log: a registered value and an authorization header token in one line", async () => {
		const dir = join(root, "fallback");
		const headerToken = ["hdr", "tok", "5".repeat(8)].join("-");
		const logger = createFallbackLogger(dir);

		logger.warn("candidate_failed", {
			error: `401 for ${RESOLVED}; sent Authorization: Bearer ${headerToken}`,
			reason: `${LONG_PREFIX}${RESOLVED}`,
		});
		await logger.settled();

		const file = written(join(dir, "logs", "fallback.log"));
		expectRedacted(file);
		expect(file).not.toContain(headerToken);
		expect(file).toContain("Authorization: Bearer [redacted]");
	});

	it("keeps ordinary text unchanged in every writer", async () => {
		const ordinary = "settings changed: theme dark, model sonnet";
		const sessionDir = join(root, "plain-session");
		createSessionLogger(sessionDir).info("reload", { reason: ordinary });
		const reloadDir = join(root, "plain-reload");
		createConfigReloadLogger(reloadDir).info("reload_deferred", { reason: ordinary });
		const compactionDir = join(root, "plain-compaction");
		createCompactionLogger(compactionDir, { mirrorToStderr: false }).info("skip_cap", { reason: ordinary });
		logGuardEvent("debug", "marker_newer", { reason: ordinary });
		await Promise.all([flushCompactionLogs(), flushGuardLog()]);

		for (const file of [
			join(sessionDir, "logs", "session.log"),
			join(reloadDir, "logs", "config-reload.log"),
			join(compactionDir, "logs", "compaction.log"),
		]) {
			expect((JSON.parse(written(file).trim()) as { reason: string }).reason).toBe(ordinary);
		}
		const guardLines = written(guardLogPath()).trim().split("\n");
		expect(guardLines.map((line) => (JSON.parse(line) as { reason: string }).reason)).toContain(ordinary);
	});
});
