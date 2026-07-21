#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { qaPortRange } from "./lib/env.mjs";
import { runNode } from "./lib/run-node.mjs";

const scripts = Object.freeze([
	["handshake", "handshake.mjs"],
	["multiclient", "multiclient.mjs"],
	["approval", "approval-roundtrip.mjs"],
	["real-client", "real-client.mjs"],
	["real-client-sweep", "real-client-sweep.mjs"],
]);
const protectedLiveDaemonPort = 18000 + 789;

const outDir = mkdtempSync(join(tmpdir(), "senpi-qa-app-server-run-all-"));

try {
	for (const [name, script] of scripts) {
		await runProbe(name, script);
		await assertNoQaPortListeners();
	}
	await assertNoAppServerListeners();
} finally {
	rmSync(outDir, { recursive: true, force: true });
}

async function runProbe(name, script) {
	const outPath = join(outDir, `${name}.txt`);
	const result = await runNode([join("scripts", "qa-app-server", script), "--out", outPath], 120000);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
	if (result.code !== 0) throw new Error(`${script} exited ${result.code}`);
	if (!result.stdout.includes(`PASS ${name}`)) throw new Error(`${script} did not print PASS ${name}`);
	process.stdout.write(`PASS ${name}\n`);
}

async function assertNoQaPortListeners() {
	const deadline = Date.now() + 30000;
	for (const port of qaPortRange) {
		let listener = tcpListener(port);
		while (listener !== "") {
			if (Date.now() >= deadline) throw new Error(`QA port still has a listener: ${port}\n${listener}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
			listener = tcpListener(port);
		}
	}
}

function tcpListener(port) {
	const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
	if (result.status === 1) return "";
	if (result.status !== 0) throw new Error(`lsof failed for ${port}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

async function assertNoAppServerListeners() {
	const result = spawnSync("pgrep", ["-fl", "app-server --listen"], { encoding: "utf8" });
	if (result.status === 1) return;
	if (result.status !== 0) throw new Error(`pgrep failed with ${result.status ?? "signal"}`);
	const forbidden = result.stdout
		.split("\n")
		.filter((line) => line.includes("app-server --listen") && !isProtectedLiveDaemon(line));
	if (forbidden.length > 0) throw new Error(`leftover app-server listener process: ${forbidden.join("; ")}`);
}

function isProtectedLiveDaemon(line) {
	return line.includes("app-server --listen") && line.includes(`:${protectedLiveDaemonPort}`);
}
