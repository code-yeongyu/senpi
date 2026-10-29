import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHostCrashRecords } from "../../../src/modes/rpc/host-crash-record.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	generationPaths,
	type HostGenerationPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { writeHostSettings } from "../../../src/modes/rpc/host-daemon-state.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { DEFAULT_STOP_TIMEOUT_MS, stopSpawnedChild } from "../../../src/modes/rpc/host-ensure-stop.ts";
import { anyGenerationLive } from "../../../src/modes/rpc/host-gc-evidence.ts";
import { pruneDeadGenerations } from "../../../src/modes/rpc/host-generations.ts";
import type { ChildExit } from "../../../src/modes/rpc/host-readiness.ts";
import { hostChildAlive } from "../../../src/modes/rpc/host-stalled-evidence.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import { CHILD_KILL_EXIT_TIMEOUT_MS } from "../../../src/modes/rpc/host-stop-intent.ts";
import { processStartTimeMs, readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { removeHostScratch } from "../../helpers/host-scratch-removal.ts";
import { processExitEvent } from "../../helpers/process-exit-event.ts";
import { type GenerationScratch, generationEnv, generationScratch } from "../../helpers/rpc-generation-support.ts";
import { processAlive } from "../../helpers/spawned-host-reaper.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-child-exit-supervisor.ts");
// lsof exits 1 with no output when nothing holds the path (socket-ownership.ts lsofSocketHolders).
const DEAD_SOCKET_LSOF_EXIT = 1;
/** Registered at spawn: a case that fails before its host is known still releases both fixture processes. */
interface Rig {
	readonly child: ChildProcess;
	readonly lease: Socket;
	hostPid: number | undefined;
	readonly qa: GenerationScratch;
}
const rigs: Rig[] = [];

async function childIdentityWritten(generation: HostGenerationPaths): Promise<void> {
	const watcher = watch(generation.dir);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			const check = async () => {
				const text = await readFile(generation.childPidFile, "utf8").catch((cause: NodeJS.ErrnoException) => {
					if (cause.code === "ENOENT") return undefined;
					throw cause;
				});
				if (text !== undefined && typeof JSON.parse(text).processStartTime === "string") resolve();
			};
			timer = setTimeout(() => reject(new Error(`child identity not written: ${generation.childPidFile}`)), 20_000);
			watcher.on("change", () => void check().catch(reject));
			watcher.once("error", reject);
			void check().catch(reject);
		});
	} finally {
		clearTimeout(timer);
		watcher.close();
	}
}

async function rig(mode: string) {
	const qa = generationScratch("3054");
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const instanceId = "child-exit";
	const generation = generationPaths(paths, instanceId);
	await createDaemonDirectories(paths);
	await writeHostSettings(paths, {
		socket: qa.socket,
		capabilities: [],
		coldStart: "persistent",
		idleExitMs: 60_000,
		generation: 0,
		instanceId,
	});
	const child = spawn(process.execPath, [fixture, mode, qa.socket, qa.agentDir], {
		env: {
			...process.env,
			...generationEnv(qa),
			SENPI_CODING_AGENT_DIR: qa.agentDir,
			SENPI_RPC_HOST_INSTANCE_ID: instanceId,
		},
		// Slot 4 is the fixture's lifetime lease (#4746): its EOF ends the supervisor and its socket host.
		stdio: ["ignore", "ignore", "pipe", "ipc", "pipe"],
	});
	const lease = child.stdio[4];
	if (!child.pid || !child.stderr || !lease) throw new Error("supervisor did not start");
	lease.on("error", () => {});
	const registered: Rig = { child, lease: lease as Socket, hostPid: undefined, qa };
	rigs.push(registered);
	let stderr = "";
	const messages: Record<string, unknown>[] = [];
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
		if (
			stderr.includes(`senpi rpc host ready on unix://${qa.socket} `) &&
			!messages.some((message) => message.type === "startup-ready")
		)
			messages.push({ type: "startup-ready" });
	});
	const exited = once(child, "exit", { signal: AbortSignal.timeout(20_000) });
	void exited.catch(() => {});
	child.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null) return;
		if ("type" in message && message.type === "host" && "pid" in message && typeof message.pid === "number")
			registered.hostPid = message.pid;
		messages.push({ ...message });
	});
	const wait = async (type: string, after = 0): Promise<Record<string, unknown>> => {
		const existing = () => messages.slice(after).find((message) => message.type === type);
		const found = existing();
		if (found) return found;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`supervisor exited before ${type}: ${stderr}`);
		return await new Promise((resolve, reject) => {
			const finish = (value?: Record<string, unknown>, error?: Error) => {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("exit", onExit);
				child.stderr?.off("data", onMessage);
				if (error) reject(error);
				else if (value) resolve(value);
			};
			const onMessage = () => {
				const value = existing();
				if (value) finish(value);
			};
			const onExit = () => finish(undefined, new Error(`supervisor exited before ${type}: ${stderr}`));
			const timer = setTimeout(() => finish(undefined, new Error(`missing ${type}: ${stderr}`)), 20_000);
			child.on("message", onMessage);
			child.once("exit", onExit);
			child.stderr?.on("data", onMessage);
		});
	};
	const host = await wait("host");
	if (typeof host.pid !== "number") throw new Error("missing host pid");
	// #4216/#4242: listen precedes key publication, ownership writes and drain-watch setup.
	await wait("startup-ready");
	if (mode === "honour-term") await wait("host-ready");
	await childIdentityWritten(generation);
	await writeHostRegistration(paths, {
		record: { pid: child.pid, processStartTime: (await readProcessStartTime(child.pid)) ?? null },
		socket: qa.socket,
		instanceId,
		generation: 0,
		launchProfileId: "child-exit-test",
	});
	return {
		qa,
		paths,
		generation,
		child,
		exited,
		wait,
		messages,
		hostPid: host.pid,
		stderr: () => stderr,
	};
}

/** A fixture pid still alive is SIGKILLed only after `ps` proves it is still this fixture (no pid reuse). */
function killFixturePid(pid: number | undefined): void {
	if (pid === undefined || !processAlive(pid)) return;
	const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
	if (command.includes(fixture)) process.kill(pid, "SIGKILL");
}

// #4746: release by the lease, never by a recorded pid alone; a fixture that survives it fails the case.
async function releaseRig(r: Rig): Promise<void> {
	const running = r.child.exitCode === null && r.child.signalCode === null;
	const supervisorExit = running ? once(r.child, "exit", { signal: AbortSignal.timeout(10_000) }) : undefined;
	void supervisorExit?.catch(() => {});
	const hostExit = r.hostPid !== undefined && processAlive(r.hostPid) ? await processExitEvent(r.hostPid) : undefined;
	try {
		r.lease.destroy();
		await supervisorExit;
		await hostExit?.wait(10_000, `fixture socket host ${r.hostPid} outlived its lease`);
	} catch (cause) {
		if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill("SIGKILL");
		killFixturePid(r.hostPid);
		throw cause;
	} finally {
		await hostExit?.dispose();
		await removeHostScratch(r.qa);
	}
}

afterEach(async () => {
	const released = await Promise.allSettled(rigs.splice(0).map(releaseRig));
	const failures = released.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length > 0) throw new AggregateError(failures, "fixture processes outlived their test");
});

// #3054: observe the real supervisor's exit, its child's reaping, and the retained ownership boundary.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("supervisor child exit", () => {
	// #4746: a test runner that dies (aborted run, killed worker) never reaches afterEach. Letting go of every
	// handle the test holds is that death as the fixture sees it: neither fixture process may outlive it.
	it("takes the supervisor and its SIGTERM-resistant host down once the test lets go", async () => {
		const r = await rig("ignore-term");
		const hostExit = await processExitEvent(r.hostPid);
		const supervisorExit = once(r.child, "exit", { signal: AbortSignal.timeout(10_000) });
		void supervisorExit.catch(() => {});
		try {
			r.child.disconnect();
			for (const stream of r.child.stdio) stream?.destroy();
			await hostExit.wait(10_000, `abandoned socket host ${r.hostPid}`);
			await supervisorExit;
		} finally {
			await hostExit.dispose();
		}
	});

	it("stops a SIGTERM-honouring host without expiring the escalation grace", async () => {
		const r = await rig("honour-term");
		const hostExit = await processExitEvent(r.hostPid);
		const before = r.messages.length;
		try {
			r.child.kill("SIGTERM");
			expect(await r.exited, r.stderr()).toEqual([143, null]);
			expect(
				r.messages.filter((message) => message.type === "child-signal").map((message) => message.signal),
			).toEqual(["SIGTERM"]);
			await hostExit.wait(10_000, `SIGTERM-honouring child ${r.hostPid}`);
			expect(await r.wait("reaped", before)).toMatchObject({ code: 0, signal: null });
			expect(processAlive(r.hostPid)).toBe(false);
			await expect(access(r.generation.dir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await hostExit.dispose();
		}
	});

	it("disarms the caller deadline after a normal real-supervisor stop", async () => {
		const r = await rig("honour-term");
		const childExit = new Promise<ChildExit>((resolve) =>
			r.child.once("exit", (code, signal) => resolve({ code, signal })),
		);
		vi.useFakeTimers();
		try {
			await stopSpawnedChild(r.child, childExit, DEFAULT_STOP_TIMEOUT_MS, {
				daemonDir: r.paths.dir,
				generation: r.generation,
				instanceId: "child-exit",
				sender: { pid: process.pid, kind: "ensure" },
				reason: "normal-stop-test",
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
		expect(await r.exited, r.stderr()).toEqual([143, null]);
	});

	it("reaps a SIGTERM-resistant child and records SIGKILL before exiting", async () => {
		const r = await rig("ignore-term");
		const hostExit = await processExitEvent(r.hostPid);
		const before = r.messages.length;
		try {
			r.child.kill("SIGTERM");
			const termWait = await r.wait("wait", before);
			expect(termWait.ms).toBe(5_000);
			r.child.send({ type: "expire", id: termWait.id });
			await hostExit.wait(10_000, `SIGTERM-resistant host child ${r.hostPid}`);
		} finally {
			await hostExit.dispose();
		}
		expect(await r.wait("reaped", before)).toMatchObject({ pid: r.hostPid, signal: "SIGKILL" });
		expect(await r.exited, r.stderr()).toEqual([143, null]);
		expect(processAlive(r.hostPid)).toBe(false);
		expect(await readHostCrashRecords(r.paths.dir)).toContainEqual(expect.objectContaining({ signal: "SIGKILL" }));
		await expect(access(r.generation.dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	// #3054: metadata failures cannot strand the host when its supervisor exits.
	it("still sends TERM then KILL when shutdown throws before its first signal", async () => {
		const r = await rig("throw-before-term");
		const hostExit = await processExitEvent(r.hostPid);
		try {
			r.child.send({ type: "inject-stop-error" });
			await r.wait("stop-error-armed");
			const before = r.messages.length;
			r.child.kill("SIGTERM");
			const termWait = await r.wait("wait", before);
			expect(termWait.ms, "shutdown recovery must wait after attempting SIGTERM").toBe(5_000);
			r.child.send({ type: "expire", id: termWait.id });
			await hostExit.wait(10_000, `host child after pre-signal shutdown failure ${r.hostPid}`);
			expect(await r.wait("reaped", before), "shutdown recovery must escalate to SIGKILL").toMatchObject({
				signal: "SIGKILL",
			});
			expect(
				r.messages.filter((message) => message.type === "child-signal").map((message) => message.signal),
			).toEqual(["SIGTERM", "SIGKILL"]);
			expect(await r.exited).toEqual([1, null]);
			expect(r.stderr()).toContain("injected before child SIGTERM");
		} finally {
			await hostExit.dispose();
		}
	});

	// #3054: a dead supervisor's retained generation belongs to an OS process identity, not just a pid.
	// #3658: an unreadable identity is released once the generation's heartbeat stopped; with no heartbeat it stays guarded.
	it.each(["same", "reused", "unreadable", "unreadable-heartbeat-stopped"] as const)(
		"judges a kept generation with a %s child start time",
		async (identity) => {
			const r = await rig("held-kill");
			const before = r.messages.length;
			r.child.kill("SIGTERM");
			const termWait = await r.wait("wait", before);
			r.child.send({ type: "expire", id: termWait.id });
			await r.wait("kill-held", before);
			const killWait =
				r.messages.slice(before).find((message) => message.type === "wait" && message.id !== termWait.id) ??
				(await r.wait("wait", r.messages.length));
			r.child.send({ type: "expire", id: killWait.id });
			expect(await r.exited).toEqual([1, null]);
			const recorded = JSON.parse(await readFile(r.generation.childPidFile, "utf8"));
			expect(typeof recorded.processStartTime).toBe("string");
			const startMs = processStartTimeMs(recorded.processStartTime);
			if (startMs === undefined) throw new Error("fixture child start time unreadable");
			await writeJsonAtomic(r.generation.childPidFile, {
				pid: r.hostPid,
				processStartTime:
					identity === "unreadable" || identity === "unreadable-heartbeat-stopped"
						? null
						: new Date(startMs - (identity === "reused" ? 60_000 : 0)).toISOString(),
			});
			if (identity === "unreadable-heartbeat-stopped")
				await writeJsonAtomic(r.generation.aliveFile, { at: new Date(Date.now() - 10 * 60_000).toISOString() });
			if (identity === "reused" || identity === "unreadable-heartbeat-stopped") {
				expect(await hostChildAlive(r.generation), "reused PID must not guard the old generation").toBe(false);
				expect(await anyGenerationLive(r.paths)).toBe(false);
				expect((await pruneDeadGenerations(r.paths)).generations, "reused PID generation must be released").toEqual(
					["child-exit"],
				);
				await expect(access(r.paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
				// The observed-dead supervisor left its public entry behind; the retained child listens only on its
				// private hop. ensureHost itself must prove that entry dead and replace it. On macOS a refused connect
				// asks `lsof -t`, whose real answer races a busy host's probe timeout, so answer it deterministically
				// with the fixture fact (no holder, lsof's exit 1) for this path only; every other lsof call is real.
				const probeBin = join(r.qa.root, "probe-bin");
				await mkdir(probeBin);
				const realLsof = execFileSync("/bin/sh", ["-c", "command -v lsof || true"], { encoding: "utf8" }).trim();
				await writeFile(
					join(probeBin, "lsof"),
					`#!/bin/sh\nif [ "$1" = "-t" ] && [ "$2" = "--" ] && [ "$3" = ${JSON.stringify(r.qa.socket)} ]; then exit ${DEAD_SOCKET_LSOF_EXIT}; fi\n${realLsof ? `exec ${JSON.stringify(realLsof)} "$@"` : "exit 2"}\n`,
					{ mode: 0o755 },
				);
				vi.stubEnv("PATH", `${probeBin}:${process.env.PATH}`);
				await expect(access(r.qa.socket)).resolves.toBeUndefined();
				const replacement = await ensureHost({
					socket: r.qa.socket,
					agentDir: r.qa.agentDir,
					_test: {
						spawn: {
							command: process.execPath,
							args: [
								join(import.meta.dirname, "../../fixtures/rpc-host-fixture.mjs"),
								r.qa.socket,
								"fixture-version",
								"multi_session,extension_events,session_context,session_kind",
								"answer",
							],
						},
					},
				});
				const replacementExit = await processExitEvent(replacement.pid);
				try {
					expect(replacement.reused, "ensure must replace the reused PID generation, not refuse it").toBe(false);
				} finally {
					replacement.release();
					process.kill(replacement.pid, "SIGTERM");
					await replacementExit.wait(10_000, "replacement fixture host");
					await replacementExit.dispose();
				}
			} else {
				expect(await hostChildAlive(r.generation), "same or unknown live child must remain guarded").toBe(true);
				expect((await pruneDeadGenerations(r.paths)).generations).toEqual([]);
				await expect(ensureHost({ socket: r.qa.socket, agentDir: r.qa.agentDir })).rejects.toMatchObject({
					reason: "host_stalled",
				});
				await access(r.generation.pidFile);
			}
		},
	);

	it("waits for the actual child exit observation before releasing its generation", async () => {
		const r = await rig("gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGTERM");
		const termWait = await r.wait("wait", before);
		r.child.send({ type: "expire", id: termWait.id });
		await r.wait("exit-held", before);
		const killWait =
			r.messages.slice(before).find((message) => message.type === "wait" && message.id !== termWait.id) ??
			(await r.wait("wait", r.messages.length));
		expect(killWait.ms).toBe(CHILD_KILL_EXIT_TIMEOUT_MS);
		await access(r.generation.pidFile);
		await access(r.paths.pointerFile);
		r.child.send({ type: "release-exit" });
		expect(await r.exited, r.stderr()).toEqual([143, null]);
		expect(await readHostCrashRecords(r.paths.dir)).toContainEqual(expect.objectContaining({ signal: "SIGKILL" }));
		await expect(access(r.paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails the breaker without releasing or replacing a still-live child's ownership", async () => {
		const r = await rig("held-kill");
		const pointer = await readFile(r.paths.pointerFile, "utf8");
		const settings = await readFile(r.paths.settingsFile, "utf8");
		const before = r.messages.length;
		r.child.kill("SIGTERM");
		const termWait = await r.wait("wait", before);
		r.child.send({ type: "expire", id: termWait.id });
		await r.wait("kill-held", before);
		const killWait =
			r.messages.slice(before).find((message) => message.type === "wait" && message.id !== termWait.id) ??
			(await r.wait("wait", r.messages.length));
		expect(killWait.ms).toBe(CHILD_KILL_EXIT_TIMEOUT_MS);
		r.child.send({ type: "expire", id: killWait.id });
		expect(await r.exited).toEqual([1, null]);
		expect(r.stderr()).toContain(`host child pid ${r.hostPid}`);
		expect(processAlive(r.hostPid)).toBe(true);
		expect(await readFile(r.paths.pointerFile, "utf8")).toBe(pointer);
		expect(await readFile(r.paths.settingsFile, "utf8")).toBe(settings);
		await access(r.generation.pidFile);
		expect(await anyGenerationLive(r.paths)).toBe(true);
		expect((await pruneDeadGenerations(r.paths)).generations).toEqual([]);
		await expect(ensureHost({ socket: r.qa.socket, agentDir: r.qa.agentDir })).rejects.toMatchObject({
			reason: "host_stalled",
		});
		expect(await readFile(r.paths.pointerFile, "utf8")).toBe(pointer);
	});
});
