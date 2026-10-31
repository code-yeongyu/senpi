#!/usr/bin/env bun
/**
 * Fail-closed offload profiling harness (senpi#3566 todo 5).
 *
 * Usage: bun scripts/qa-rpc-socket/offload-profile.mjs --sessions N --runtime in-process|child --out <dir>
 *          [--big-open 25,293] [--shape small|big] [--mutate no-exec|force-timeout] [--turn-timeout <ms>]
 *
 * One sandboxed host (the built CLI, under `bun --cpu-prof`) serves N sessions running the planning
 * workload against a local mock model, then a manual `compact` each, the optional big opens, and close.
 * The report records per-phase memory of the verified server pid and its descendants, probe latency,
 * the CPU profiles and a sample-count `cpu-top.md`. Exit 0 iff the derived validity oracle passes
 * (`lib/offload-evaluate.mjs`); any missing record or measurement exits 1 with named reasons.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rankProfile, renderCpuTop, shareOf } from "./lib/cpu-top.mjs";
import { runBigOpens } from "./lib/offload-big-open.mjs";
import { evaluateValidity } from "./lib/offload-evaluate.mjs";
import { memorySnapshot, processExited, processTable, verifyServerPid } from "./lib/offload-memory.mjs";
import { closeAll, compactAll, openSessions, percentiles, runTurns, startProbe } from "./lib/offload-sessions.mjs";
import { MUTATIONS, sessionPrompt, workloadResponder } from "./lib/offload-workload.mjs";
import { startMockModel } from "./lib/mock-model.mjs";
import { startQaHost, writeSandboxAgentDir } from "./lib/qa-host.mjs";

const packageDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = resolve(packageDir, "../..");
const flag = (name) => {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
};
const sessions = Number(flag("--sessions") ?? 10);
const runtime = flag("--runtime") ?? "in-process";
const out = resolve(flag("--out") ?? "");
const mutate = flag("--mutate");
const shape = flag("--shape") ?? "small";
const bigSizes = (flag("--big-open") ?? "").split(",").filter(Boolean).map(Number);
const turnTimeoutMs = Number(flag("--turn-timeout") ?? (mutate === "force-timeout" ? 10_000 : 300_000));
if (!flag("--out") || !(sessions > 0) || !["in-process", "child"].includes(runtime) || (mutate && !MUTATIONS.includes(mutate))) {
	process.stderr.write("usage: offload-profile.mjs --sessions N --runtime in-process|child --out <dir> [--mutate no-exec|force-timeout]\n");
	process.exit(2);
}

const t0 = performance.now();
mkdirSync(out, { recursive: true });
const log = (line) => {
	const stamped = `[${((performance.now() - t0) / 1000).toFixed(1)}s] ${line}`;
	process.stderr.write(`${stamped}\n`);
	writeFileSync(join(out, "driver.log"), `${stamped}\n`, { flag: "a" });
};

function hostStatus(agentDir) {
	const text = execFileSync(process.execPath, [join(packageDir, "dist", "cli.js"), "host", "status", "--all", "--json"], {
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SENPI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		encoding: "utf8",
	});
	return JSON.parse(text.split("\n").find((line) => line.trim().startsWith("{") || line.trim().startsWith("[")) ?? "null");
}

function collectProfiles(rawDir, serverPid) {
	const cpuDir = join(out, "cpu");
	mkdirSync(cpuDir, { recursive: true });
	const files = existsSync(rawDir) ? readdirSync(rawDir).filter((name) => name.endsWith(".cpuprofile")) : [];
	const result = { server: undefined, children: [] };
	for (const name of files) {
		const pid = Number(/\.(\d+)\.\d+\.\d+\.cpuprofile$/.exec(name)?.[1]);
		const isServer = pid === serverPid;
		const target = join(cpuDir, isServer ? "server.cpuprofile" : `child-${pid}.cpuprofile`);
		renameSync(join(rawDir, name), target);
		const profile = JSON.parse(readFileSync(target, "utf8"));
		const rows = rankProfile(profile);
		const entry = { file: target, pid, total_samples: profile.samples.length, top: rows.slice(0, 50) };
		if (isServer) result.server = { ...entry, rows };
		else result.children.push(entry);
	}
	return result;
}

const report = { schema: 1, sessions, runtime, shape, mutate: mutate ?? null, turn_timeout_ms: turnTimeoutMs };
const scratch = mkdtempSync("/tmp/eop-");
let mock;
let host;
try {
	const workdir = join(scratch, "w");
	execFileSync("git", ["clone", "--quiet", "--shared", repoRoot, workdir]);
	mock = await startMockModel(workloadResponder(mutate));
	const agentDir = join(scratch, "agent");
	writeSandboxAgentDir(agentDir, { baseUrl: mock.baseUrl, workdir });
	const rawCpu = join(scratch, "cpu");
	host = await startQaHost({ scratch, agentDir, runtime, cpuDir: rawCpu, env: { SENPI_RPC_LOOP_LAG_WARN_MS: "50" } });
	report.engine = host.protocolInfo.serverVersion ?? host.protocolInfo.engineVersion;
	report.capabilities = host.protocolInfo.capabilities ?? [];
	const server = await verifyServerPid({ statusJson: hostStatus(agentDir), socket: host.socket, supervisorPid: host.pid, table: await processTable() });
	report.server = server;
	log(`host supervisor=${host.pid} server=${server.pid} verified=${server.verified} ${server.reason ?? ""}`);
	if (!server.verified) throw new Error(`server pid unverified: ${server.reason}`);
	report.memory = { empty: await memorySnapshot(server.pid) };
	const opened = await openSessions({ socket: host.socket, count: sessions, cwd: workdir });
	report.open_ms = opened.map((s) => s.openMs);
	report.memory.opened = await memorySnapshot(server.pid);
	const probe = await startProbe(host.socket);
	probe.setPhase("turns");
	const turnsStarted = performance.now();
	await runTurns(opened, sessionPrompt, turnTimeoutMs);
	report.turns_ms = Math.round(performance.now() - turnsStarted);
	log(`turns: ${opened.filter((s) => s.settled).length}/${sessions} settled in ${report.turns_ms} ms`);
	report.memory.after_turns = await memorySnapshot(server.pid);
	probe.setPhase("compact");
	report.compactions = await compactAll(opened);
	probe.setPhase("big_open");
	report.big_opens = await runBigOpens({ socket: host.socket, sizes: bigSizes, shape, dir: scratch, cwd: workdir });
	report.memory.after_big_opens = await memorySnapshot(server.pid);
	const series = await probe.stop();
	report.probe = percentiles(series.map((sample) => sample.ms));
	const bigProbes = series.filter((sample) => sample.phase === "big_open").map((sample) => sample.ms);
	report.big_open_probe_max_ms = bigProbes.length > 0 ? Math.max(...bigProbes) : null;
	report.sessions_detail = opened.map((s) => ({ n: s.n, session_id: s.sessionId, settled: s.settled, tool_events: s.toolEvents }));
	report.tool_events_total = opened.reduce((sum, s) => sum + s.toolEvents.length, 0);
	await closeAll(opened);
	report.memory.after_close = await memorySnapshot(server.pid);
	const toolChildren = report.memory.after_turns.children.filter((child) => /tool-child/.test(child.cmd));
	report.child_idle_mb = toolChildren.length > 0 ? Math.max(...toolChildren.map((child) => child.mb ?? 0)) : null;
	report.host_stop = await host.stop();
	host = undefined;
	report.server_exited = await processExited(server.pid);
	await processExited(report.host_stop?.pid ?? server.supervisorPid);
	const profiles = collectProfiles(rawCpu, server.pid);
	if (profiles.server) {
		const { rows, ...serverEntry } = profiles.server;
		report.cpu = { server: serverEntry, children: profiles.children };
		report.serialization_share = shareOf(rows, "JSON.stringify") + shareOf(rows, "transformJsonValue");
		writeFileSync(join(out, "cpu-top.md"), renderCpuTop(rows, { limit: 50, totalSamples: serverEntry.total_samples }));
	} else {
		report.cpu = { server: null, children: profiles.children };
	}
} catch (error) {
	report.harness_error = error instanceof Error ? error.message : String(error);
	log(`harness error: ${report.harness_error}`);
} finally {
	if (host) report.host_stop = await host.stop().catch((error) => ({ error: String(error) }));
	await mock?.stop();
	rmSync(scratch, { recursive: true, force: true });
}

report.validity = evaluateValidity(report);
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
log(`validity pass=${report.validity.pass} failures=${report.validity.failures.map((failure) => failure.reason).join(",") || "none"}`);
process.exit(report.validity.pass ? 0 : 1);
