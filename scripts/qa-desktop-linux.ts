#!/usr/bin/env node
// Linux live QA driver for the desktop engine (todo 35): X11 under Xvfb + xfwm4, Wayland on
// `sway --headless`. Runs ON the Linux host under test (Debian-family, user-level tools only):
//
//   bun scripts/qa-desktop-linux.ts --all --json [--provision] [--workdir DIR] [--engine BIN]
//       [--fake-eis BIN] [--scenario NAME]... [--sabotage skip-optin]
//
// One JSON line per scenario `{scenario, pass, facts, observer: {before, after}}`, then the teardown
// receipts (`procs 0`, `dir REMOVED <run dir>`) as the last lines; exit 0 iff every line passed.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { exists, Processes } from "./qa-desktop-linux/procs.ts";
import { provision, toolEnv } from "./qa-desktop-linux/provision.ts";
import { type Context, failure, type Result, SABOTAGES, type Sabotage } from "./qa-desktop-linux/scenario.ts";
import { startWayland } from "./qa-desktop-linux/wayland-env.ts";
import { runWayland, WAYLAND_SCENARIOS, type WaylandScenario } from "./qa-desktop-linux/wayland.ts";
import { startX11 } from "./qa-desktop-linux/x11-env.ts";
import { runX11, X11_SCENARIOS, type X11Scenario } from "./qa-desktop-linux/x11.ts";

const { values } = parseArgs({
	options: {
		all: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		provision: { type: "boolean", default: false },
		scenario: { type: "string", multiple: true, default: [] },
		sabotage: { type: "string" },
		workdir: { type: "string" },
		engine: { type: "string" },
		"fake-eis": { type: "string" },
	},
});

function isX11(name: string): name is X11Scenario {
	return X11_SCENARIOS.some((known) => known === name);
}

function isWayland(name: string): name is WaylandScenario {
	return WAYLAND_SCENARIOS.some((known) => known === name);
}

function isSabotage(mode: string): mode is Sabotage {
	return SABOTAGES.some((known) => known === mode);
}

function usage(message: string): never {
	process.stderr.write(`qa-desktop-linux: ${message}\n`);
	process.exit(2);
}

const requested = values.all ? [...X11_SCENARIOS, ...WAYLAND_SCENARIOS] : values.scenario;
if (requested.length === 0) usage("pass --all or --scenario <name>");
const unknown = requested.filter((name) => !isX11(name) && !isWayland(name));
if (unknown.length > 0) usage(`unknown scenario(s): ${unknown.join(", ")}`);
const sabotage = values.sabotage;
if (sabotage !== undefined && !isSabotage(sabotage)) usage(`unknown sabotage mode ${sabotage}`);

const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const workdir = values.workdir ?? `/tmp/senpi-desktop-qa-${stamp}`;
const runId = `${Date.now()}-${process.pid}`;
const runDir = join(workdir, `run-${runId}`);
mkdirSync(runDir, { recursive: true });
const procs = new Processes(runId, { ...process.env, ...toolEnv(join(workdir, "root"), process.env) });
const ctx: Context = {
	procs,
	engineBinary: values.engine ?? join(workdir, "bin/senpi-desktop-engine"),
	fakeEisBinary: values["fake-eis"] ?? join(workdir, "bin/senpi-qa-fake-eis"),
	runDir,
	sabotage,
};

let allPassed = true;
function emit(line: Result | { receipt: string; pass: boolean }): void {
	const text = JSON.stringify(line);
	allPassed &&= line.pass;
	process.stdout.write(values.json ? `${text}\n` : `${"scenario" in line ? line.scenario : line.receipt}: ${line.pass ? "PASS" : "FAIL"}\n`);
}

async function family<T extends string, S, O>(
	names: readonly T[],
	start: () => Promise<{ stage: S; observe: O }>,
	run: (name: T, stage: S, observe: O) => Promise<Result>,
): Promise<void> {
	if (names.length === 0) return;
	let staged: { stage: S; observe: O };
	try {
		staged = await start();
	} catch (error) {
		for (const name of names) emit(failure(name, error));
		return;
	}
	for (const name of names) {
		try {
			emit(await run(name, staged.stage, staged.observe));
		} catch (error) {
			emit(failure(name, error));
		}
	}
}

try {
	if (values.provision) {
		for (const line of await provision(procs, workdir)) process.stderr.write(`${line}\n`);
	}
	await family(
		requested.filter(isX11),
		() => startX11(procs, runDir),
		(name, stage, observe) => runX11(name, ctx, stage, observe),
	);
	await family(
		requested.filter(isWayland),
		() => startWayland(procs, runDir),
		(name, stage, observe) => runWayland(name, ctx, stage, observe),
	);
} finally {
	for (const receipt of await procs.stopAll()) process.stderr.write(`teardown: ${receipt}\n`);
	const left = procs.marked().length;
	emit({ receipt: `procs ${left}`, pass: left === 0 });
	rmSync(runDir, { recursive: true, force: true });
	const removed = !exists(runDir);
	emit({ receipt: `dir ${removed ? "REMOVED" : "LEFT"} ${runDir}`, pass: removed });
}
process.exitCode = allPassed ? 0 : 1;
