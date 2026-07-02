import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = join(repoRoot, "scripts/perf-trend-local.sh");
const tempDirs: string[] = [];

type TrendEntry = {
	readonly suite: string;
	readonly label: string;
	readonly n: number | null;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly bytesPerFrameP50: number | null;
};

type CommandResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
};

function isTrendEntry(value: unknown): value is TrendEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"suite" in value &&
		typeof value.suite === "string" &&
		"label" in value &&
		typeof value.label === "string" &&
		"n" in value &&
		(typeof value.n === "number" || value.n === null) &&
		"p50Ms" in value &&
		typeof value.p50Ms === "number" &&
		"p95Ms" in value &&
		typeof value.p95Ms === "number" &&
		"bytesPerFrameP50" in value &&
		(typeof value.bytesPerFrameP50 === "number" || value.bytesPerFrameP50 === null)
	);
}

function runTrend(extraEnv: Record<string, string>): CommandResult {
	const result = spawnSync("bash", [scriptPath], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PERF_TREND_FRAME_SMALL_N: "3",
			PERF_TREND_FRAME_LARGE_N: "5",
			PERF_TREND_ITERATIONS: "1",
			...extraEnv,
		},
	});
	if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
		throw new TypeError("Expected utf8 output from perf trend child process");
	}
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseTrend(path: string): readonly TrendEntry[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line: string) => line.trim().length > 0)
		.map((line: string) => {
			const parsed: unknown = JSON.parse(line);
			if (!isTrendEntry(parsed)) {
				throw new Error(`Invalid trend entry: ${line}`);
			}
			return parsed;
		});
}

function createTrendOutputPath(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return join(dir, "perf-trend.json");
}

after(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("perf trend local mirror", () => {
	it("writes parseable JSONL entries for the headless bench list", () => {
		const givenOutputPath = createTrendOutputPath("senpi-perf-trend-");

		const whenResult = runTrend({ PERF_TREND_OUTPUT: givenOutputPath });

		assert.strictEqual(whenResult.status, 0, whenResult.stderr || whenResult.stdout);
		const thenEntries = parseTrend(givenOutputPath);
		assert.ok(thenEntries.length >= 3);
		assert.ok(thenEntries.some((entry) => entry.label === "frame-cost-n3"));
		assert.ok(thenEntries.some((entry) => entry.label === "frame-cost-n5"));
		assert.ok(thenEntries.some((entry) => entry.label === "frame-cost-n5-viewport"));
	});

	it("keeps advisory failure injection non-blocking", () => {
		const givenOutputPath = createTrendOutputPath("senpi-perf-trend-edge-");

		const whenResult = runTrend({ PERF_TREND_INJECT_FAIL: "1", PERF_TREND_OUTPUT: givenOutputPath });

		assert.strictEqual(whenResult.status, 0, whenResult.stderr || whenResult.stdout);
		assert.match(`${whenResult.stdout}\n${whenResult.stderr}`, /bench failed \(advisory\)/);
		assert.ok(parseTrend(givenOutputPath).length >= 3);
	});
});
