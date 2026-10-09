import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "log-rotation-race-worker.ts");
const WORKERS = 4;
const LINES_PER_WORKER = 400;
const MAX_BYTES = 8 * 1024;

interface WorkerResult {
	written: number;
	dropped: number;
}

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function logLines(path: string): string[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

describe("senpi#2976 processes sharing one config-reload log across the rotation cap", () => {
	it("never disables a process's sink and never tears a line", async () => {
		// given several processes that log through the same agent dir and are released at the same moment
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-2976-"));
		directories.push(agentDir);
		const barrier = join(agentDir, "go");
		const runs = Array.from({ length: WORKERS }, (_, index) =>
			execFileAsync(
				process.execPath,
				[workerPath, agentDir, barrier, `w${index}`, String(LINES_PER_WORKER), String(MAX_BYTES)],
				{ timeout: 60_000 },
			),
		);

		// when they all write far past the small rotation cap
		writeFileSync(barrier, "");
		const results = (await Promise.all(runs)).map(
			(run) => JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as WorkerResult,
		);

		// then no process dropped a line, and every surviving line is a whole JSON record
		expect(results.map((result) => result.dropped)).toEqual(Array(WORKERS).fill(0));
		expect(results.every((result) => result.written === LINES_PER_WORKER)).toBe(true);
		const logPath = join(agentDir, "logs", "config-reload.log");
		for (const line of [...logLines(logPath), ...logLines(`${logPath}.1`)]) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	}, 90_000);
});
