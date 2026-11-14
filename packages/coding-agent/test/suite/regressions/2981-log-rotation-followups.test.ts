import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rotateLogIfNeeded } from "../../../src/core/log-file-rotation.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

/** Spawns a child that exits at once and returns its (now dead) pid. */
function deadPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--version"], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", () => resolve(child.pid ?? -1));
	});
}

function backdate(path: string, ageMs: number): void {
	const stale = new Date(Date.now() - ageMs);
	utimesSync(path, stale, stale);
}

describe("senpi#2981 log rotation follow-ups", () => {
	it("never clears a stale lock whose owner process is still alive", () => {
		// given a log over the cap and a lock file whose owner (this process) is alive but whose
		// mtime is older than the staleness threshold (a paused holder, not a crashed one)
		const directory = tempDir("senpi-2981-");
		const logPath = join(directory, "app.log");
		writeFileSync(logPath, "x".repeat(100));
		const lockPath = `${logPath}.rotate-lock`;
		writeFileSync(lockPath, `${process.pid}:${randomUUID()}`);
		backdate(lockPath, 20_000);

		// when rotation is attempted
		rotateLogIfNeeded(logPath, 1, 10);

		// then the live holder's lock is left alone and nothing is rotated
		expect(existsSync(lockPath)).toBe(true);
		expect(existsSync(`${logPath}.1`)).toBe(false);
		expect(existsSync(logPath)).toBe(true);
	});

	it("still clears a stale lock whose owner process is gone, and rotates on the next call", async () => {
		// given a log over the cap and a stale lock file owned by a dead process
		const directory = tempDir("senpi-2981-");
		const logPath = join(directory, "app.log");
		writeFileSync(logPath, "x".repeat(100));
		const lockPath = `${logPath}.rotate-lock`;
		writeFileSync(lockPath, `${await deadPid()}:${randomUUID()}`);
		backdate(lockPath, 20_000);

		// when rotation is attempted the stale lock is cleared (this call skips rotation),
		// and the next call acquires a fresh lock and rotates
		rotateLogIfNeeded(logPath, 1, 10);
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(logPath)).toBe(true);
		rotateLogIfNeeded(logPath, 1, 10);
		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(`${logPath}.1`, "utf8")).toBe("x".repeat(100));
	});

	it("notes a paused MCP file sink once per outage, not once per retry window", async () => {
		vi.useFakeTimers();
		try {
			const directory = tempDir("senpi-2981-");
			const logDir = join(directory, "logs");
			mkdirSync(logDir, { recursive: true });
			const logger = createMcpLogger("alpha", { logDir });
			// block the file path with a directory so every write fails
			const blockedPath = join(logDir, "alpha.log");
			const sinkNotes = (): string[] => logger.getRingBuffer().filter((line) => line.includes("file sink"));

			mkdirSync(blockedPath);
			logger.error("boom 1");
			expect(sinkNotes()).toHaveLength(1);
			expect(sinkNotes()[0]).toContain("retrying");

			// a second failed attempt after the retry window is the same outage: still one note
			await vi.advanceTimersByTimeAsync(6_000);
			logger.error("boom 2");
			expect(sinkNotes()).toHaveLength(1);

			// a successful write ends the outage; the next failure is a new outage
			rmSync(blockedPath, { recursive: true, force: true });
			await vi.advanceTimersByTimeAsync(6_000);
			logger.error("recovered");
			expect(sinkNotes()).toHaveLength(1);
			rmSync(blockedPath, { force: true });
			mkdirSync(blockedPath);
			await vi.advanceTimersByTimeAsync(6_000);
			logger.error("boom 3");
			expect(sinkNotes()).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
