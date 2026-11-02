#!/usr/bin/env node
/**
 * Zombie matrix for the shared RPC host process: how many Z-state children
 * survive per {spawn API} x {thread} x {runtime} x {lifecycle} cell.
 *
 * Each cell runs `spawn-zombie-probe.mjs` (the host-process model) under one
 * runtime, waits for the cell's milestone, lets the cell settle, and counts the
 * probe's Z-state children from OUTSIDE the probe - the measurement never
 * perturbs the process under test.
 *
 * Runtimes:
 *   bun-source    `bun <probe>`                      (a `bun src/cli.ts` host)
 *   bun-compiled  `bun build --compile` of the probe (a shipped binary host)
 *   node          `node <probe>`                     (npm-installed Node host)
 *
 * Usage:
 *   node scripts/qa-rpc-socket/spawn-zombie-matrix.mjs [--out <table.md>] [--json <file>]
 *     [--count 20] [--reaper-ms <ms>] [--extra-settle-ms <ms>] [--only <substring>]
 *
 * `--reaper-ms` arms the real host reaper inside every probe with that window,
 * so the same cells can be measured with and without it.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const probePath = join(here, "spawn-zombie-probe.mjs");
const flag = (name, fallback) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
};
const count = Number(flag("--count", "20"));
const reaperMs = flag("--reaper-ms", undefined);
const extraSettleMs = Number(flag("--extra-settle-ms", "0"));
const only = flag("--only", undefined);
const apis = ["node", "bun-spawn", "bun-shell"];

/** Lifecycle cells: the milestone to wait for and how long to let the cell settle. */
const lifecycles = [
	{ name: "steady", args: ["--case", "steady"], marker: "MSG:done", settleMs: 2_000, threads: ["main", "worker"] },
	{
		name: "terminate-live",
		args: ["--case", "terminate-live", "--terminate", "yes", "--live-ms", "1500"],
		marker: "MSG:terminated",
		settleMs: 4_000,
		threads: ["worker"],
	},
	{
		name: "terminate-after-exit",
		args: ["--case", "terminate-after-exit", "--terminate", "yes"],
		marker: "MSG:terminated",
		settleMs: 3_000,
		threads: ["worker"],
	},
	{
		name: "blocked-sync-during",
		args: ["--case", "blocked-sync", "--block-ms", "12000"],
		marker: "MSG:spawned",
		settleMs: 4_000,
		threads: ["main", "worker"],
	},
	{
		name: "blocked-sync-after",
		args: ["--case", "blocked-sync", "--block-ms", "12000"],
		marker: "MSG:unblocked",
		settleMs: 1_500,
		threads: ["main", "worker"],
	},
];

const runtimes = [
	{ name: "bun-source", command: () => ["bun", [probePath]] },
	{ name: "bun-compiled", command: (binary) => [binary, []] },
	{ name: "node", command: () => ["node", [probePath]], apis: ["node"] },
];

function compileProbe(directory) {
	const binary = join(directory, "spawn-zombie-probe");
	execFileSync("bun", ["build", "--compile", probePath, "--outfile", binary], { encoding: "utf8" });
	return binary;
}

/** Z-state children of one pid, with the comm names the kernel still reports. */
function zombieChildren(pid) {
	return execFileSync("ps", ["-axo", "ppid=,pid=,stat=,comm="], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([parent, , state]) => Number(parent) === pid && state?.startsWith("Z"));
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCell(cell) {
	const [command, prefix] = cell.command;
	const args = [
		...prefix,
		"--api",
		cell.api,
		"--thread",
		cell.thread,
		"--count",
		String(count),
		...cell.args,
		...(reaperMs === undefined ? [] : ["--reaper-ms", reaperMs]),
	];
	const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timeout waiting ${cell.marker}: ${stdout} ${stderr}`)), 40_000);
			const check = () => {
				if (!stdout.includes(cell.marker)) return;
				clearTimeout(timer);
				resolve();
			};
			child.stdout.on("data", check);
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error(`probe exited early: ${stdout} ${stderr}`));
			});
			check();
		});
		const pid = Number(/PID=(\d+)/.exec(stdout)[1]);
		await delay(cell.settleMs + extraSettleMs);
		const zombies = zombieChildren(pid);
		const childExit = /MSG:childExit=(\S+)/.exec(stdout)?.[1];
		return { zombies: zombies.length, childExit, stderr: stderr.trim() };
	} finally {
		child.kill("SIGKILL");
	}
}

function cells(binary) {
	const planned = [];
	for (const lifecycle of lifecycles) {
		for (const runtime of runtimes) {
			for (const api of runtime.apis ?? apis) {
				for (const thread of lifecycle.threads) {
					planned.push({
						lifecycle: lifecycle.name,
						runtime: runtime.name,
						api,
						thread,
						args: lifecycle.args,
						marker: lifecycle.marker,
						settleMs: lifecycle.settleMs,
						command: runtime.command(binary),
					});
				}
			}
		}
	}
	return only === undefined ? planned : planned.filter((cell) => JSON.stringify(cell).includes(only));
}

function renderTable(results) {
	const header = "| lifecycle | spawn API | thread | runtime | zombies | child exit code |";
	const rows = results.map(
		(result) =>
			`| ${result.lifecycle} | ${result.api} | ${result.thread} | ${result.runtime} | ${result.zombies} | ${result.childExit ?? "-"} |`,
	);
	return [header, "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n");
}

const directory = mkdtempSync(join(tmpdir(), "dh-zmx-"));
try {
	const binary = compileProbe(directory);
	const results = [];
	for (const cell of cells(binary)) {
		const outcome = await runCell(cell);
		results.push({ ...cell, ...outcome });
		process.stdout.write(
			`${cell.lifecycle}/${cell.api}/${cell.thread}/${cell.runtime} zombies=${outcome.zombies}` +
				`${outcome.childExit === undefined ? "" : ` childExit=${outcome.childExit}`}\n`,
		);
	}
	const table = renderTable(results);
	process.stdout.write(`\n${table}\n`);
	const outPath = flag("--out", undefined);
	if (outPath) writeFileSync(outPath, `${table}\n`);
	const jsonPath = flag("--json", undefined);
	if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(results, undefined, "\t")}\n`);
	process.exit(0);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
