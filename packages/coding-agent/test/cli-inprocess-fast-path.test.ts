import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * `cli.ts` historically ran the real agent (`cli-main.ts`) as a spawned child so that an
 * inherited Inspector socket could be handed over and so brand env scrubbing could not leak
 * back to the launcher. That second Node process costs a full spawn plus a duplicated
 * entry-module graph on every single launch, and neither reason applies to a plain run.
 *
 * These tests pin the observable process structure: a plain launch must load `cli-main` in the
 * SAME process, while an isolation-requiring launch (custom exec args, or an inherited
 * `--inspect*`) must keep the child spawn exactly as before.
 *
 * The probe is a `--import` hook published through `NODE_OPTIONS`, which — unlike a `--import`
 * on the command line — leaves `process.execArgv` empty, so it observes the fast path instead of
 * disabling it. Every process that loads it appends one record, so the record count IS the
 * process count: no polling, no sleeps, no platform-specific process-tree walking.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const probeHookSource = `import { appendFileSync } from "node:fs";
const report = process.env.SENPI_FAST_PATH_REPORT;
process.on("exit", () => {
	appendFileSync(report, JSON.stringify({ pid: process.pid, entry: process.argv[1] }) + "\\n");
});
`;

interface ProbeRecord {
	readonly pid: number;
	readonly entry: string;
}

interface RunResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly records: readonly ProbeRecord[];
}

let hostDir: string;

function runCli(args: readonly string[], nodeOptionsPrefix = ""): RunResult {
	const hookPath = join(hostDir, "probe-hook.mjs");
	const reportPath = join(hostDir, `report-${Math.random().toString(36).slice(2)}.jsonl`);
	writeFileSync(hookPath, probeHookSource);
	writeFileSync(reportPath, "");
	const nodeOptions = `${nodeOptionsPrefix} --import=${pathToFileURL(hookPath).href} --import tsx`.trim();
	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			NODE_OPTIONS: nodeOptions,
			SENPI_FAST_PATH_REPORT: reportPath,
			PI_OFFLINE: "1",
		},
	});
	const records = readFileSync(reportPath, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ProbeRecord);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, records };
}

beforeEach(() => {
	hostDir = mkdtempSync(join(tmpdir(), "senpi-fast-path-"));
});

afterEach(() => {
	rmSync(hostDir, { recursive: true, force: true });
});

describe("CLI in-process fast path", () => {
	describe("#given a launch that needs no exec-arg or inspector isolation", () => {
		test("#when the CLI runs #then cli-main loads in the launcher process itself", () => {
			const result = runCli(["--help"]);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("Usage:");
			// One record = one Node process. The child spawn would add a second record whose
			// entry is cli-main, so this assertion is exactly the "no respawn" contract.
			expect(result.records).toHaveLength(1);
			expect(result.records[0]?.entry).toBe(CLI_PATH);
		});

		test("#when the CLI exits non-zero #then the launcher reports that exact code", () => {
			const result = runCli(["--model", "definitely-not-a-real-model-id", "--print", "hi"]);

			// Deterministic failure: an unknown model id is rejected before any provider call.
			expect(result.status).toBe(1);
			expect(result.records).toHaveLength(1);
		});
	});

	describe("#given a launch that inherits an Inspector option", () => {
		test("#when NODE_OPTIONS carries --inspect #then the agent still runs in a spawned child", () => {
			// Port 0 lets the OS pick a free port, so concurrent runs cannot collide.
			const result = runCli(["--help"], "--inspect=127.0.0.1:0");

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("Usage:");
			expect(result.records).toHaveLength(2);
			const entries = result.records.map((record) => record.entry);
			expect(entries).toContain(CLI_PATH);
			expect(entries.some((entry) => entry.includes("cli-main"))).toBe(true);
			expect(new Set(result.records.map((record) => record.pid)).size).toBe(2);
		});
	});
});
