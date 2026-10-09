#!/usr/bin/env bun
/**
 * Live load + contention proof for ONE real `--listen` socket host.
 *
 * Boots a host the way the daemon runs (`--mode rpc --multi-session --listen
 * unix://...`, whose default session runtime is in-process), points it at the
 * fake model server from `scripts/qa-app-server/lib/env.mjs` through a generated
 * `models.json`, and drives two cells over ONE socket connection:
 *
 *   (i)   SCALE       open `--sessions` sessions, then `list_sessions
 *                     { include_workers: true }`; host threads and RSS before/after.
 *   (iii) CONTENTION  time-to-first-event for one session at a time, then for 50
 *                     sessions streaming at once. The RATIO is reported, never gated:
 *                     wall-clock latency is not a contract this host controls.
 *
 * No real provider is reachable: the only model is `mock/mock-model`, served by a
 * local HTTP server this script owns.
 *
 * The report records WHICH runtime the host actually ran, never an assumption: the
 * host's own argv read back with `ps`, the runtime `resolveSessionRuntime` selects for
 * that argv, and the host's `get_protocol_info`. The worker runtime's admission bound
 * (20) is the independent witness - a host that admitted 1,000 sessions is not it.
 *
 * Usage:
 *   bun scripts/qa-rpc-socket/load-1000.mjs [--sessions 1000] [--concurrent 50]
 *     [--baseline 20] [--session-runtime in-process|worker] [--disable-builtin <id>]
 *     [--out <file.json>]
 *
 * Exit 0 when every open succeeded; exit 1 (with `firstError` in the report) when
 * the host refused one - which is what `--session-runtime worker` does at its cap.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupAllAndWait, installCleanupHooks, startFakeModelServer, writeMockModelsJson } from "../qa-app-server/lib/env.mjs";
import { trackChild } from "../qa-app-server/lib/cleanup.mjs";
import { parseArgs, resolveSessionRuntime } from "../../src/cli/args.ts";
import { connectJsonlSocket } from "./lib/jsonl-socket.mjs";

const sessionCount = Number(flag("--sessions") ?? 1000);
const concurrentStreams = Number(flag("--concurrent") ?? 50);
const baselineStreams = Number(flag("--baseline") ?? 20);
const sessionRuntime = flag("--session-runtime");
const disabledBuiltin = flag("--disable-builtin");
// Checkpoints the cost curve is sampled at, so "bounded pool" and "per-session thread"
// are distinguishable from the report alone.
const checkpoints = (flag("--curve") ?? "10,100,1000").split(",").map(Number);
// Observation only: an env name=value the HOST is started with (never a fix).
const hostEnv = Object.fromEntries(
	process.argv.filter((token, index) => process.argv[index - 1] === "--host-env").map((pair) => pair.split("=")),
);
const outPath = flag("--out");
const packageDir = resolve(import.meta.dirname, "..", "..");
const READY_BUDGET_MS = 60_000;
const COMMAND_BUDGET_MS = 120_000;

installCleanupHooks();

async function main() {
	// Short prefix on purpose: a unix socket path must stay under 104 bytes.
	const scratch = mkdtempSync("/tmp/dh-ld-");
	const agentDir = join(scratch, "agent");
	const cwd = join(scratch, "cwd");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	// Causal cell: the same host with one builtin extension switched off, which is how the
	// per-session thread was attributed to a component instead of to "a session".
	if (disabledBuiltin) {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ disabledBuiltinExtensions: [disabledBuiltin] }));
	}
	const socketPath = join(scratch, `load-${process.pid}.sock`);
	const fake = await startFakeModelServer([{ text: "load-1000" }]);
	writeMockModelsJson(agentDir, fake);

	const host = spawn(
		"bun",
		[
			join(packageDir, "src", "cli.ts"),
			"--mode",
			"rpc",
			"--multi-session",
			"--listen",
			`unix://${socketPath}`,
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--provider",
			"mock",
			"--model",
			"mock-model",
			...(sessionRuntime === undefined ? [] : ["--session-runtime", sessionRuntime]),
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: scratch,
				TMPDIR: scratch,
				SENPI_CODING_AGENT_DIR: agentDir,
				OMO_CODING_AGENT_DIR: agentDir,
				SENPI_OFFLINE: "1",
				PI_OFFLINE: "1",
				...hostEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	trackChild(host);
	let stderr = "";
	host.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
	await waitFor(() => stderr.includes("senpi rpc listening on"), READY_BUDGET_MS, () => `host never listened: ${stderr}`);

	const client = await connectJsonlSocket(socketPath, COMMAND_BUDGET_MS);
	const report = { sessions: 0, errors: 0, hostPid: host.pid };
	try {
		report.runtime = describeRuntime(host.pid, await client.request({ type: "get_protocol_info" }));
		if (disabledBuiltin) report.disabledBuiltin = disabledBuiltin;
		report.threads = { before: threadCount(host.pid) };
		report.rssMb = { before: residentMb(host.pid) };
		report.fds = { before: descriptorCount(host.pid) };
		const opened = [];
		report.curve = [];
		const openStarted = performance.now();
		for (let index = 0; index < sessionCount; index++) {
			const response = await client.request({ type: "open_session", cwd, kind: "worker", auto_title: false });
			if (response.success !== true) {
				report.errors++;
				report.firstError ??= { index, error: response.error };
				break;
			}
			opened.push(response.data.sessionId);
			if (checkpoints.includes(opened.length)) report.curve.push(sample(host.pid, opened.length, report));
		}
		report.sessions = opened.length;
		report.openMsPerSession = Math.round(performance.now() - openStarted) / Math.max(1, opened.length);
		report.threads.after = threadCount(host.pid);
		report.rssMb.after = residentMb(host.pid);
		report.fds.after = descriptorCount(host.pid);
		// NOT "flat": the measured per-session cost, whatever it turns out to be.
		report.threadsPerSession = perSession(report.threads, opened.length);
		report.rssMbPerSession = perSession(report.rssMb, opened.length);
		report.fdsPerSession = perSession(report.fds, opened.length);
		const listed = await client.request({ type: "list_sessions", include_workers: true });
		report.listed = listed.data.sessions.length;
		report.listMs = listed.elapsedMs;

		if (report.errors === 0) {
			// Every measured session is prompted for the FIRST time: a session reused across
			// samples would answer the tap with the tail of its previous turn.
			const single = [];
			for (let sample = 0; sample < baselineStreams; sample++) {
				const sessionId = opened[sample];
				const settled = client.waitForRecord(sessionId, (record) => record.type === "agent_idle");
				single.push(await client.timeToFirstEvent(sessionId, `baseline ${sample}`));
				await settled;
			}
			const streaming = opened.slice(baselineStreams, baselineStreams + concurrentStreams);
			const settling = streaming.map((sessionId) =>
				client.waitForRecord(sessionId, (record) => record.type === "agent_idle"),
			);
			const concurrent = await Promise.all(
				streaming.map((sessionId) => client.timeToFirstEvent(sessionId, "concurrent")),
			);
			await Promise.all(settling);
			report.ttfePairP95 = { single: percentile(single, 95), concurrent50: percentile(concurrent, 95) };
			report.ttfePairP50 = { single: percentile(single, 50), concurrent50: percentile(concurrent, 50) };
			report.ttfeRatioP95 = Number((report.ttfePairP95.concurrent50 / report.ttfePairP95.single).toFixed(1));
		}
	} finally {
		client.dispose();
		await stopHost(host);
		report.orphans = Number(execFileSync("/bin/sh", ["-c", `pgrep -f load-${process.pid}.sock | wc -l`], { encoding: "utf8" }).trim());
		await fake.stop().catch(() => undefined);
		rmSync(scratch, { recursive: true, force: true });
		report.cleanup = { scratchRemoved: true, hostStopped: true };
	}
	return report;
}

async function stopHost(host) {
	if (host.exitCode !== null) return;
	const exited = new Promise((done) => host.once("close", done));
	host.kill("SIGTERM");
	const deadline = setTimeout(() => host.kill("SIGKILL"), 15_000);
	await exited;
	clearTimeout(deadline);
}

function waitFor(condition, budgetMs, describe) {
	return new Promise((ready, fail) => {
		const deadline = Date.now() + budgetMs;
		const poll = () => {
			if (condition()) return ready();
			if (Date.now() > deadline) return fail(new Error(describe()));
			setTimeout(poll, 50);
		};
		poll();
	});
}

function percentile(samples, rank) {
	const sorted = [...samples].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
	return Number((sorted[index] ?? Number.NaN).toFixed(2));
}

/**
 * What the host is, read off the host: its own argv, the runtime `resolveSessionRuntime`
 * selects for that argv (production code, fed the observed command line), and what the
 * host answers to `get_protocol_info`.
 */
function describeRuntime(pid, protocolInfo) {
	// Home is rewritten to `~`: this report is an evidence artifact, not a local log.
	const argv = ps(["-o", "command=", "-p", String(pid)]).replaceAll(homedir(), "~");
	const flags = argv.split(/\s+/);
	const firstFlag = flags.findIndex((token) => token.startsWith("--"));
	return {
		hostArgv: argv,
		resolvedFromArgv: firstFlag === -1 ? "unknown" : resolveSessionRuntime(parseArgs(flags.slice(firstFlag))),
		serverVersion: protocolInfo.data?.serverVersion,
		capabilities: protocolInfo.data?.capabilities,
	};
}

/** One point of the cost curve: what the HOST process holds at this session count. */
function sample(pid, sessions, report) {
	const threads = threadCount(pid);
	const fds = descriptorCount(pid);
	const rssMb = residentMb(pid);
	const per = (value, before) => Number(((value - before) / sessions).toFixed(2));
	return {
		sessions,
		threads,
		fds,
		rssMb,
		threadsPerSession: per(threads, report.threads.before),
		fdsPerSession: per(fds, report.fds.before),
		rssMbPerSession: per(rssMb, report.rssMb.before),
	};
}

const perSession = (pair, sessions) => Number(((pair.after - pair.before) / Math.max(1, sessions)).toFixed(2));
const threadCount = (pid) => ps(["-M", String(pid)]).split("\n").length - 1;
const residentMb = (pid) => Math.round(Number(ps(["-o", "rss=", "-p", String(pid)])) / 1024);
const ps = (args) => execFileSync("ps", args, { encoding: "utf8" }).trim();
const descriptorCount = (pid) =>
	Number(execFileSync("/bin/sh", ["-c", `lsof -p ${pid} | wc -l`], { encoding: "utf8" }).trim()) - 1;

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

let report;
let failure;
try {
	report = await main();
} catch (error) {
	failure = error instanceof Error ? error.stack : String(error);
	report = { sessions: 0, errors: 1, failure };
}
await cleanupAllAndWait();
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outPath) writeFileSync(outPath, serialized);
process.stdout.write(serialized);
process.exit(report.errors === 0 ? 0 : 1);
