import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigReloadLogger } from "../../../src/core/extensions/builtin/config-reload/log.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";
import { LOG_SINK_RETRY_MS } from "../../../src/core/log-file-rotation.ts";

const directories: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-2976-recovery-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	vi.useRealTimers();
	for (const directory of directories.splice(0)) {
		chmodSync(directory, 0o700);
		rmSync(directory, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"senpi#2976 a log sink that failed once writes again later",
	() => {
		it("config-reload logger reopens its file after the retry window", () => {
			// given a logger whose log directory refuses writes
			vi.useFakeTimers();
			const agentDir = tempDir();
			const logsDir = join(agentDir, "logs");
			mkdirSync(logsDir);
			chmodSync(logsDir, 0o500);
			const logger = createConfigReloadLogger(agentDir);
			expect(logger.info("watcher_started", { targetCount: 1 })).toEqual({ written: false, disabled: true });

			// when the directory takes writes again and the retry window passes
			chmodSync(logsDir, 0o700);
			expect(logger.info("watcher_started", { targetCount: 2 })).toEqual({ written: false, disabled: true });
			vi.advanceTimersByTime(LOG_SINK_RETRY_MS);

			// then the next line is written instead of the sink staying off for the process lifetime
			expect(logger.info("watcher_started", { targetCount: 3 })).toEqual({ written: true, disabled: false });
			expect(readFileSync(join(logsDir, "config-reload.log"), "utf8")).toContain('"targetCount":3');
		});

		it("MCP logger reopens its file sink after the retry window", () => {
			// given an MCP logger whose log directory refuses writes
			vi.useFakeTimers();
			const logDir = join(tempDir(), "mcp");
			mkdirSync(logDir);
			chmodSync(logDir, 0o500);
			const logger = createMcpLogger("recovering", { logDir });
			logger.info("lost line");
			expect(existsSync(logger.filePath)).toBe(false);

			// when the directory takes writes again and the retry window passes
			chmodSync(logDir, 0o700);
			vi.advanceTimersByTime(LOG_SINK_RETRY_MS);
			logger.info("recovered line");

			// then the file sink writes again
			expect(readFileSync(logger.filePath, "utf8")).toContain("recovered line");
		});
	},
);
