#!/usr/bin/env node
/**
 * Child-reaping measurement for a shared multi-session host: how many Z-state
 * children of the HOST PROCESS survive a burst of `bash` spawns routed through
 * one session.
 *
 * Both session runtimes are driven through the same seam the real host uses
 * (`createHostCore`), so the number is comparable across them:
 *   --runtime in-process  createHostCore WITHOUT workerConfiguration -> RpcSessionRegistry
 *                         (the runtime a `--listen` socket host selects)
 *   --runtime worker      createHostCore WITH workerConfiguration -> WorkerSessionRegistry
 * Either way the bash children are children of THIS process (worker isolates are
 * threads), so `ps -axo ppid=,stat=` filtered by our pid sees every one of them.
 *
 * Two cells:
 *   --case bash        50 `bash true` commands through one session (the daemon's
 *                      busiest path).
 *   --case quarantine  a session worker is terminated while its bash child is
 *                      still running - the `session-worker-client.ts` quarantine
 *                      shape, which is where the matrix says children leak.
 *
 * `--reaper-ms <ms>` arms the real host reaper in this process with that window,
 * so the same cell can be measured with and without it.
 *
 * This driver REPORTS; it does not decide policy. `--max-zombies <n>` turns the
 * measurement into a gate for the caller that wants one.
 *
 * Usage (bun runs the runtime the daemon ships; `node --import tsx` keeps the
 * Node comparison available):
 *   bun scripts/qa-rpc-socket/worker-spawn-zombie.mjs --runtime in-process \
 *     [--case bash|quarantine] [--spawns 50] [--settle-ms 6000] [--reaper-ms 5000] \
 *     [--max-zombies <n>] [--out <file>]
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { cleanupAllAndWait, installCleanupHooks, makeScratch } from "../qa-app-server/lib/env.mjs";

const runtime = flag("--runtime") ?? "in-process";
const kase = flag("--case") ?? "bash";
const reaperMs = flag("--reaper-ms");
const spawns = Number(flag("--spawns") ?? 50);
const settleMs = Number(flag("--settle-ms") ?? 6000);
const maxZombies = flag("--max-zombies") === undefined ? undefined : Number(flag("--max-zombies"));
const outPath = flag("--out");
const transcript = [];

if (runtime !== "in-process" && runtime !== "worker") {
	throw new Error(`--runtime must be in-process or worker (got: ${runtime})`);
}
if (kase !== "bash" && kase !== "quarantine") {
	throw new Error(`--case must be bash or quarantine (got: ${kase})`);
}
installCleanupHooks();

async function main() {
	const scratch = makeScratch("zombie");
	process.env.SENPI_CODING_AGENT_DIR = scratch.agentDir;
	process.env.SENPI_OFFLINE = "1";
	process.env.PI_OFFLINE = "1";
	const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"]);
	const configuration = { parsed, cwd: scratch.cwd, agentDir: scratch.agentDir, appMode: "rpc" };
	const records = new Map();
	const writer = new SessionEventWriter((line) => {
		const record = JSON.parse(line);
		if (record.id) records.set(record.id, record);
	});
	const { router } = createHostCore(
		{
			agentDir: scratch.agentDir,
			createRuntime: createCliRuntimeFactory(configuration),
			cwd: scratch.cwd,
			...(runtime === "worker" ? { workerConfiguration: configuration } : {}),
		},
		writer,
		[],
		// The quarantine cell needs the worker terminated while its child runs, which
		// is what a zero grace period asks the registry for.
		kase === "quarantine" ? { closeGraceMs: 1 } : {},
	);
	if (reaperMs !== undefined) await armReaper(Number(reaperMs));
	transcript.push(`runtime=${runtime} case=${kase} hostPid=${process.pid} spawns=${spawns} settleMs=${settleMs}`);
	transcript.push(`threadsBefore=${threadCount()}`);
	try {
		const sessionId = await request(router, writer, records, { type: "open_session", cwd: scratch.cwd }).then(
			(response) => response.data.sessionId,
		);
		transcript.push(`session=${sessionId}`);
		if (kase === "quarantine") {
			// Fire and forget: the command must still be running when the session closes.
			void request(router, writer, records, { type: "bash", sessionId, command: "sleep 3" }).catch(() => {});
			await settle(500);
			await request(router, writer, records, { type: "close_session", sessionId });
			transcript.push("quarantined=1");
		} else {
			for (let spawn = 0; spawn < spawns; spawn++) {
				const response = await request(router, writer, records, { type: "bash", sessionId, command: "true" });
				if (response.success !== true) throw new Error(`bash ${spawn} failed: ${JSON.stringify(response)}`);
			}
			transcript.push(`bashCompleted=${spawns}`);
		}
		transcript.push(`zombiesBeforeSettle=${zombieCount()}`);
		await settle(settleMs);
		const zombies = zombieCount();
		transcript.push(`threadsAfter=${threadCount()}`);
		transcript.push(
			`RESULT runtime=${runtime} case=${kase} spawns=${spawns} settleMs=${settleMs} ` +
				`reaperMs=${reaperMs ?? "off"} zombies=${zombies}`,
		);
		if (maxZombies !== undefined && zombies > maxZombies) {
			throw new Error(`zombies=${zombies} exceeds --max-zombies ${maxZombies}`);
		}
		transcript.push("PASS worker-spawn-zombie");
	} finally {
		await router.dispose();
	}
}

/** Arms the real host reaper in this process, exactly as a socket host does. */
async function armReaper(minWaitableMs) {
	const { createChildReaper } = await import("../../src/modes/rpc/child-reaper.ts");
	const { loadChildReaperSyscalls } = await import("../../src/modes/rpc/child-reaper-syscalls.ts");
	const syscalls = await loadChildReaperSyscalls();
	if (syscalls === undefined) {
		transcript.push("reaper=unavailable");
		return;
	}
	const reaper = createChildReaper({ syscalls, minWaitableMs, log: (message) => transcript.push(message) });
	setInterval(() => reaper.tick(), 1_000).unref();
}

/** Sends one command and resolves with the response record the writer emitted for it. */
async function request(router, writer, records, command) {
	const id = `zombie-${records.size + 1}`;
	const immediate = await router.handle({ ...command, id });
	await writer.flush();
	const response = immediate ?? records.get(id);
	if (!response) throw new Error(`no response for ${command.type} (${id})`);
	return response;
}

function settle(ms) {
	return new Promise((resolveSettle) => setTimeout(resolveSettle, ms));
}

/** Z-state children of this process, i.e. exited children nobody has waited on. */
function zombieCount() {
	const table = execFileSync("ps", ["-axo", "ppid=,stat="], { encoding: "utf8" });
	return table
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([ppid, stat]) => Number(ppid) === process.pid && stat?.startsWith("Z")).length;
}

function threadCount() {
	return execFileSync("ps", ["-M", String(process.pid)], { encoding: "utf8" }).trim().split("\n").length;
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

function finish(code) {
	const text = `${transcript.join("\n")}\n`;
	process.stdout.write(text);
	if (outPath) writeFileSync(outPath, text);
	process.exit(code);
}

try {
	await main();
	await cleanupAllAndWait();
	finish(0);
} catch (error) {
	transcript.push(`FAIL worker-spawn-zombie ${error instanceof Error ? error.message : String(error)}`);
	await cleanupAllAndWait();
	finish(1);
}
