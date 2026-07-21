import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigReloadLogger } from "../../src/core/extensions/builtin/config-reload/log.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-config-reload-log-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		chmodSync(join(dir, "logs"), 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("config reload logger", () => {
	it("writes parseable JSONL entries", () => {
		const agentDir = createTempDir();
		const logger = createConfigReloadLogger(agentDir);

		const status = logger.info("change_detected", {
			registrationId: "settings",
			paths: ["/workspace/.senpi/settings.json"],
			deferred: false,
		});
		logger.error("watcher_error", {
			path: "/workspace/.senpi/settings.json",
			message: "watcher closed",
		});

		expect(status).toEqual({ written: true, disabled: false });
		const entries = readFileSync(join(agentDir, "logs", "config-reload.log"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries).toEqual([
			expect.objectContaining({
				level: "info",
				event: "change_detected",
				registrationId: "settings",
				paths: ["/workspace/.senpi/settings.json"],
				deferred: false,
			}),
			expect.objectContaining({
				level: "error",
				event: "watcher_error",
				path: "/workspace/.senpi/settings.json",
				message: "watcher closed",
			}),
		]);
		for (const entry of entries) expect(entry.ts).toEqual(expect.any(String));
	});

	it("rotates to .1 when the next line exceeds the injected size cap", () => {
		const agentDir = createTempDir();
		const logger = createConfigReloadLogger(agentDir, { maxBytes: 130 });

		logger.info("registration_added", { id: "first-registration" });
		logger.info("registration_added", { id: "second-registration" });

		const logPath = join(agentDir, "logs", "config-reload.log");
		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(`${logPath}.1`, "utf8")).toContain('"id":"first-registration"');
		expect(readFileSync(logPath, "utf8")).toContain('"id":"second-registration"');
	});

	it("disables silently and returns status when its log directory is unwritable", () => {
		const agentDir = createTempDir();
		const logsDir = join(agentDir, "logs");
		mkdirSync(logsDir);
		chmodSync(logsDir, 0o500);
		const logger = createConfigReloadLogger(agentDir);

		expect(logger.warn("watcher_started", { targetCount: 1 })).toEqual({ written: false, disabled: true });
		expect(logger.warn("watcher_started", { targetCount: 2 })).toEqual({ written: false, disabled: true });
		expect(existsSync(join(logsDir, "config-reload.log"))).toBe(false);
	});
});
