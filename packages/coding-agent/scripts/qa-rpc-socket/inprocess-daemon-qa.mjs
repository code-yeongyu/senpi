#!/usr/bin/env node
/**
 * Live QA for the in-process shared daemon, end to end on REAL COMPILED BINARIES.
 *
 * Everything a client does to a machine-wide daemon, in one run and one sandbox: two generations
 * compiled from this tree (same code, different `SENPI_BUILD_EPOCH`), a daemon ensured with
 * `pi host ensure --json` from the older one, the per-session identity a worker session's own
 * extension instance sees, the cost of fifty sessions, the visibility class `list_sessions`
 * honours, a retained session across a dropped connection, the child-reaping of a 200-command bash
 * burst, and a generation handoff performed by the newer binary while a client is still connected.
 *
 * One JSON line per step, written synchronously, so a step that hangs has still printed every step
 * before it - and the LAST line is always the cleanup receipt: which hosts were stopped, whether
 * any survived, whether a fixture host is running anywhere on this machine, and whether the sandbox
 * is gone. A run that leaves a daemon behind exits non-zero; a shared host outliving its QA is
 * exactly the failure this script exists to catch.
 *
 * POSIX only (unix socket, `ps`, `pgrep`); thread counts are read with `ps -M`, which is macOS.
 *
 * Usage:
 *   node scripts/qa-rpc-socket/inprocess-daemon-qa.mjs [--older <pi>] [--newer <pi>] [--keep]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModelServer, writeMockModelsJson } from "../qa-app-server/lib/env.mjs";
import { resolveGenerations } from "./lib/compiled-generations.mjs";
import { createDaemonSandbox } from "./lib/daemon-sandbox.mjs";
import { sessionDriver } from "./lib/daemon-sessions.mjs";
import { alive, awaitPidGone, reap } from "./lib/host-processes.mjs";

const SESSIONS = 50;
const BASH_CALLS = 200;
/** The host reaper's own window plus room for the last child of the burst to be waited on. */
const SETTLE_MS = 6_000;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const keep = process.argv.includes("--keep");
const flag = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const say = (step, data) => writeFileSync(1, `${JSON.stringify({ step, ...data })}\n`);
const lineCounts = (paths) => Object.fromEntries(paths.map((path) => [path, jsonLines(path).length]));
const jsonLines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const everyLineParses = (path) =>
	jsonLines(path).every((line) => {
		try {
			JSON.parse(line);
			return true;
		} catch {
			return false;
		}
	});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout ?? "";
const childPids = (pid) => text("pgrep", ["-P", String(pid)]).split("\n").filter(Boolean).map(Number);
const threads = (pid) => text("ps", ["-M", String(pid)]).trim().split("\n").length - 1;
const treeThreads = (pid) => [pid, ...childPids(pid)].reduce((total, id) => total + threads(id), 0);
const pgrepCount = (pattern) => text("pgrep", ["-f", pattern]).split("\n").filter(Boolean).length;

const sandbox = createDaemonSandbox();
const wire = sessionDriver(sandbox.socket, sandbox.cwd);
const startedPids = [];
const socketInodes = [];
let generations;
let fake;

try {
	generations = resolveGenerations(packageDir, sandbox.buildDir, { older: flag("--older"), newer: flag("--newer") });
	say("binaries", { platform: `${process.platform}-${process.arch}`, ...generations });

	fake = await startFakeModelServer([{ text: "inprocess-daemon-qa turn" }]);
	writeMockModelsJson(sandbox.agentDir, fake);
	say("sandbox", { root: sandbox.root, socket: sandbox.socket, spec: sandbox.spec, model: fake.url });

	const ensured = sandbox.host(generations.older.path, ["ensure", "--json", "--launch-spec", sandbox.spec]);
	startedPids.push(ensured.json.pid);
	socketInodes.push(statSync(sandbox.socket).ino);
	say("ensure", {
		exitCode: ensured.exitCode,
		action: ensured.json.action,
		pid: ensured.json.pid,
		hostPids: childPids(ensured.json.pid),
		engineVersion: ensured.json.engineVersion,
		engineOrdinal: ensured.json.engineOrdinal,
		launchProfileId: ensured.json.launchProfileId,
		socketInode: socketInodes[0],
	});

	const lanes = await wire.connect();
	const first = await wire.open(lanes, { kind: "worker", context: { lane: "alpha", owner: "qa_first" } });
	const second = await wire.open(lanes, { kind: "worker", context: { lane: "beta", owner: "qa_second" } });
	const seenByFirst = await wire.probe(lanes, first.sessionId);
	const seenBySecond = await wire.probe(lanes, second.sessionId);
	say("context", {
		seenByFirst,
		seenBySecond,
		isolated: seenByFirst.context.owner === "qa_first" && seenBySecond.context.owner === "qa_second",
	});

	const defaultRows = await wire.rows(lanes, false);
	const workerRows = await wire.rows(lanes, true);
	say("workers-hidden", {
		defaultRows: defaultRows.length,
		workerRows: workerRows.length,
		contexts: workerRows.map((row) => row.context),
		workersHidden: defaultRows.length === 0 && workerRows.length === 2,
	});
	lanes.dispose();

	const scale = await wire.connect();
	const threadsBefore = treeThreads(ensured.json.pid);
	const opened = [];
	let refusal = null;
	for (let index = 0; index < SESSIONS && refusal === null; index++) {
		const admission = await wire.tryOpen(scale, { kind: "worker" });
		if (admission.admitted) opened.push(admission.sessionId);
		else refusal = admission.error;
	}
	const threadsAfter = treeThreads(ensured.json.pid);
	say("scale", {
		sessions: opened.length,
		listed: (await wire.rows(scale, true)).length,
		refusal,
		threads: { before: threadsBefore, after: threadsAfter },
		threadsPerSession: Number(((threadsAfter - threadsBefore) / Math.max(1, opened.length)).toFixed(2)),
	});

	const retainPath = join(sandbox.sessionDir, "retain.jsonl");
	const holder = await wire.connect();
	const held = await wire.open(holder, { sessionPath: retainPath, retain_on_disconnect: true });
	holder.dispose();
	const detached = await wire.awaitDetach(scale, held.sessionId);
	const rebound = await wire.connect();
	const reattached = await wire.open(rebound, { sessionPath: retainPath, retain_on_disconnect: true });
	say("retain", {
		sessionPath: retainPath,
		detached,
		attached: reattached.attached === true,
		sameSession: reattached.sessionId === held.sessionId,
	});

	const busy = await wire.connect();
	const burst = await wire.open(busy, { kind: "worker" });
	for (let call = 0; call < BASH_CALLS; call++) {
		const response = await busy.request({ type: "bash", sessionId: burst.sessionId, command: "true" });
		if (response.success !== true) throw new Error(`bash ${call} failed: ${response.error}`);
	}
	await delay(SETTLE_MS);
	const status = sandbox.host(generations.older.path, ["status", "--json", "--include-workers"]);
	say("zombies", {
		bashCalls: BASH_CALLS,
		settleMs: SETTLE_MS,
		zombies: status.json.zombies,
		rssMb: status.json.rss_mb,
		openFds: status.json.open_fds,
		sessions: status.json.sessions,
	});

	// The handoff cell starts from a known occupancy: every earlier cell's client leaves, so the
	// predecessor's only remaining clients are the three sessions this cell carries across.
	wire.disposeAll();
	const carried = ["gen-a", "gen-b", "gen-c"].map((name) => join(sandbox.handoffDir, `${name}.jsonl`));
	const outgoing = await wire.connect();
	for (const path of carried) {
		const session = await wire.open(outgoing, { sessionPath: path });
		await wire.turn(outgoing, session.sessionId, "before the handoff");
	}
	const before = lineCounts(carried);
	const upgrade = sandbox.host(generations.newer.path, [
		"ensure",
		"--json",
		"--policy",
		"upgrade",
		"--launch-spec",
		sandbox.spec,
	]);
	startedPids.push(upgrade.json.pid);
	socketInodes.push(statSync(sandbox.socket).ino);
	// The proof that the handoff kept its predecessor's clients: a command issued AFTER the socket
	// was taken over, on the connection that was open before it, still answered by the old host.
	const survived = await outgoing.request({ type: "list_sessions", include_workers: true });
	outgoing.dispose();
	const oldGenerationExited = await awaitPidGone(ensured.json.pid);
	const incoming = await wire.connect();
	const reopened = [];
	for (const path of carried) {
		const session = await wire.open(incoming, { sessionPath: path });
		await wire.turn(incoming, session.sessionId, "after the handoff");
		reopened.push({ path, attached: session.attached === true });
	}
	const after = lineCounts(carried);
	const afterPaths = (await wire.rows(incoming, true))
		.map((row) => row.sessionPath)
		.filter((path) => path.startsWith(sandbox.handoffDir));
	say("handoff", {
		exitCode: upgrade.exitCode,
		action: upgrade.json.action,
		pid: upgrade.json.pid,
		oldConnectionAlive: survived.success === true,
		instanceChanged: upgrade.json.instanceId !== ensured.json.instanceId,
		olderEpoch: ensured.json.engineOrdinal[4],
		newerEpoch: upgrade.json.engineOrdinal[4],
		epochsDiffer: ensured.json.engineOrdinal[4] !== upgrade.json.engineOrdinal[4],
		oldGenerationExited,
		sessionPathsEqual: same([...carried].sort(), [...afterPaths].sort()),
		transcriptsMonotonic: carried.every((path) => after[path] > before[path]) && carried.every(everyLineParses),
		lines: { before, after },
		reopened,
		inodes: socketInodes,
		inodeChanges: new Set(socketInodes).size - 1,
	});

	const reensure = sandbox.host(generations.older.path, ["ensure", "--json", "--launch-spec", sandbox.spec]);
	const listed = sandbox.host(generations.newer.path, ["status", "--json"]).json.generations ?? [];
	say("reensure-older", {
		exitCode: reensure.exitCode,
		action: reensure.json.action,
		sameInstance: reensure.json.instanceId === upgrade.json.instanceId,
		generations: listed.map((entry) => ({ generation: entry.generation, alive: entry.alive, current: entry.current })),
	});
} catch (cause) {
	say("failed", { error: cause instanceof Error ? cause.stack : String(cause) });
	process.exitCode = 1;
} finally {
	wire.disposeAll();
	await fake?.stop().catch(() => undefined);
	const stopped = stopEveryHost();
	const reaped = [];
	for (const pid of startedPids) {
		if (await awaitPidGone(pid)) continue;
		reaped.push(await reap(pid));
	}
	const survivors = startedPids.filter(alive);
	if (!keep) sandbox.remove();
	say("cleanup", {
		hostsStarted: startedPids,
		stopAction: stopped,
		reaped,
		hostsAlive: survivors.length,
		fixtureHosts: pgrepCount("rpc-host-fixture.mjs"),
		sandboxHosts: pgrepCount(sandbox.root),
		sandboxRemoved: !existsSync(sandbox.root),
		root: sandbox.root,
		kept: keep,
	});
	if (survivors.length > 0) process.exitCode = 1;
}

/** Ends whatever still serves the sandbox socket, whichever generation that turned out to be. */
function stopEveryHost() {
	if (generations === undefined) return "none";
	try {
		return sandbox.host(generations.newer.path, ["stop", "--json", "--force"]).json.action;
	} catch (cause) {
		return `stop_failed: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
}
