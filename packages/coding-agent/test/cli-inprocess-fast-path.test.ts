import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "./support/workspace-build-prerequisite.ts";

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

// Without the tsx loader the spawned CLI resolves workspace packages the way a real child does,
// through their built `dist`. An unbuilt checkout must say so here instead of letting the children
// die at import, which would leave the status-1 cases passing on the wrong failure.
assertWorkspaceBuildPrerequisite(import.meta.url);

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** Model id no catalog can hold, so resolution rejects it before any provider call. */
const UNKNOWN_MODEL_ID = "definitely-not-a-real-model-id";

/**
 * The rejection the two status-1 cases are supposed to observe, worded as the product words it in
 * `src/core/model-resolver.ts`. Asserting the text is what separates "the agent ran and refused the
 * model" from "the process died of something else and also exited 1".
 */
const UNKNOWN_MODEL_ERROR = `Model "${UNKNOWN_MODEL_ID}" not found. Use --list-models to see available models.`;

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
	// No `--import tsx`: the package requires Node >= 24, which runs this TypeScript entry natively,
	// and every module of this repository is erasable syntax. A tsx loader would esbuild-transform the
	// whole engine graph inside EVERY process launched here - and the `--inspect` case launches two -
	// which is what pushed both cases past the 30 s budget on loaded containers (#4624, same cost class
	// as #4554). Node's own transform is per-process cheap and `NODE_COMPILE_CACHE`, published by the
	// launcher, carries across to the spawned child.
	const nodeOptions = `${nodeOptionsPrefix} --import=${pathToFileURL(hookPath).href}`.trim();
	const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			NODE_OPTIONS: nodeOptions,
			// Pin the runtime: an ambient `SENPI_RUNTIME=bun` (every senpi-launched shell exports it) makes
			// `cli.ts` re-exec itself under Bun before the isolation decision, and Bun ignores the
			// `NODE_OPTIONS --import` probe, so the records would stop counting the processes that run.
			SENPI_RUNTIME: "node",
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
			const result = runCli(["--model", UNKNOWN_MODEL_ID, "--print", "hi"]);

			// Deterministic failure: an unknown model id is rejected before any provider call. The text
			// pins WHICH failure produced the 1, so an import-time crash cannot stand in for it.
			expect(result.stderr).toContain(UNKNOWN_MODEL_ERROR);
			expect(result.status).toBe(1);
			expect(result.records).toHaveLength(1);
		});
	});

	describe("#given a launch that inherits an Inspector option", () => {
		test("#when NODE_OPTIONS carries --inspect #then the agent still runs in a spawned child", () => {
			// Port 0 lets the OS pick a free port, so concurrent runs cannot collide. The launch must
			// reach the agent: a cached `--help` is answered before the isolation decision, because no
			// agent runs for a help screen and there is no socket to hand over.
			const result = runCli(["--model", UNKNOWN_MODEL_ID, "--print", "hi"], "--inspect=127.0.0.1:0");

			// The spawned child inherits this process's stderr, so the agent's rejection proves the child
			// reached model resolution rather than dying at import with the same exit code.
			expect(result.stderr).toContain(UNKNOWN_MODEL_ERROR);
			expect(result.status).toBe(1);
			expect(result.records).toHaveLength(2);
			const entries = result.records.map((record) => record.entry);
			expect(entries).toContain(CLI_PATH);
			expect(entries.some((entry) => entry.includes("cli-main"))).toBe(true);
			expect(new Set(result.records.map((record) => record.pid)).size).toBe(2);
		});
	});
});
