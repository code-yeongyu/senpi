import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readlinkSync, watch } from "node:fs";
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
import { prepareSocketPath } from "../../../src/modes/rpc/host-lifecycle-proxy.ts";
import { CHILD_KILL_EXIT_TIMEOUT_MS, childLivenessRecheckMs } from "../../../src/modes/rpc/host-stop-intent.ts";
import { processStartTimeMs, readProcessStartTime } from "../../../src/utils/process-identity.ts";
import { removeHostScratch } from "../../helpers/host-scratch-removal.ts";
import { processExitEvent } from "../../helpers/process-exit-event.ts";
import { type GenerationScratch, generationEnv, generationScratch } from "../../helpers/rpc-generation-support.ts";
import { processAlive } from "../../helpers/spawned-host-reaper.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

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
			...hostSpawnEnv(),
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
	const wait = async (
		type: string,
		after = 0,
		match: (message: Record<string, unknown>) => boolean = () => true,
	): Promise<Record<string, unknown>> => {
		const existing = () => messages.slice(after).find((message) => message.type === type && match(message));
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

type RigHandle = Awaited<ReturnType<typeof rig>>;
/** The supervisor's own per-platform re-check cadence: 15 s on Linux, 60 s on macOS (senpi#7525 delta review). */
const LIVENESS_RECHECK_MS = childLivenessRecheckMs();
const expiredRechecks = new WeakMap<RigHandle, Set<unknown>>();

/** Fires the supervisor's armed child re-check: the newest one queued, since each re-check re-arms the next. */
async function expireLivenessRecheck(r: RigHandle): Promise<void> {
	const expired = expiredRechecks.get(r) ?? new Set<unknown>();
	expiredRechecks.set(r, expired);
	const pending = () =>
		r.messages.filter((message) => message.type === "wait" && message.ms === LIVENESS_RECHECK_MS).at(-1);
	const latest = pending();
	const armed =
		latest && !expired.has(latest.id)
			? latest
			: await r.wait("wait", r.messages.length, (message) => message.ms === LIVENESS_RECHECK_MS);
	expired.add(armed.id);
	r.child.send({ type: "expire", id: armed.id });
}

function signalsSince(r: RigHandle, index: number): unknown[] {
	return r.messages
		.slice(index)
		.filter((message) => message.type === "child-signal")
		.map((message) => message.signal);
}

/** Resolves with the first of `texts` the supervisor has logged; the bound only reports a line that never comes. */
async function stderrIncludes(r: RigHandle, ...texts: readonly [string, ...string[]]): Promise<string> {
	const logged = () => texts.find((text) => r.stderr().includes(text));
	const already = logged();
	if (already !== undefined) return already;
	const stream = r.child.stderr;
	if (!stream) throw new Error("supervisor stderr unavailable");
	return new Promise<string>((resolve, reject) => {
		const timer = setTimeout(
			() => finish(new Error(`supervisor never logged any of ${JSON.stringify(texts)}: ${r.stderr()}`)),
			20_000,
		);
		const onData = () => {
			const text = logged();
			if (text !== undefined) finish(undefined, text);
		};
		const finish = (error?: Error, text?: string) => {
			clearTimeout(timer);
			stream.off("data", onData);
			if (error) reject(error);
			else if (text !== undefined) resolve(text);
		};
		stream.on("data", onData);
	});
}

const GONE_UNOBSERVED = "its exit was not observed; confirming";
const STILL_RUNNING_AT_EOF = "closed its lifetime pipe but is still running";

/**
 * senpi#7606: the first `gone` observation of a drained host whose exit is held. The lifetime EOF prompts a check, but
 * a dying process closes its descriptors before it is a zombie, so that check may still see the child running. Then
 * the next periodic re-check (held by the fixture until expired) is the first to see it gone.
 */
async function firstGoneObservation(r: RigHandle): Promise<void> {
	if ((await stderrIncludes(r, GONE_UNOBSERVED, STILL_RUNNING_AT_EOF)) === GONE_UNOBSERVED) return;
	await expireLivenessRecheck(r);
	await stderrIncludes(r, GONE_UNOBSERVED);
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

	// oh-my-openagent#14725 (senpi#7525): a drained generation whose successor never took over. Its host parks nothing
	// and exits on its own, and the supervisor never hears that exit (the runtime reaped the child and the event never
	// came). Re-checking the child's identity proves it gone; the generation then ends WITHOUT a signal to a pid that is
	// no longer its child, and gives up the public socket instead of refusing every client and every fresh bind.
	it("gives up the public socket, sending no signal, when its drained host is gone and the exit is never observed", async () => {
		const r = await rig("drain-gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		// The first observation that sees the child gone; off Linux it waits on `ps`, so the confirming re-check is fired
		// only once that first one has seen the child gone.
		await firstGoneObservation(r);
		await expireLivenessRecheck(r);

		expect(await r.exited, r.stderr()).toEqual([1, null]);
		expect(signalsSince(r, before)).toEqual([]);
		expect(r.stderr()).toContain("its exit was never observed");
		// Nothing serves the endpoint any more: the supervisor released its own generation and pointer, and a fresh bind
		// may take the path.
		await expect(access(r.generation.dir)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(r.paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(prepareSocketPath(r.qa.socket)).resolves.toBeUndefined();
		await expect(access(r.qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	});

	// senpi#7606: a dying host closes its lifetime pipe before it is a zombie, so the EOF check can still see it running.
	// This host makes that order certain; the case must reach the same verdict through the periodic re-check.
	it("gives up the public socket when its draining host closed its lifetime pipe before it was gone", async () => {
		const r = await rig("early-close-gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		await firstGoneObservation(r);
		await expireLivenessRecheck(r);

		expect(await r.exited, r.stderr()).toEqual([1, null]);
		expect(signalsSince(r, before)).toEqual([]);
		expect(r.stderr()).toContain(STILL_RUNNING_AT_EOF);
		expect(r.stderr()).toContain("its exit was never observed");
	});

	// senpi#7525 review: a stop must prove the pid is still its own live child before signalling it.
	it("stops without signalling a child that was already reaped while its exit went unobserved", async () => {
		const r = await rig("drain-gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		r.child.kill("SIGTERM");
		const first = await Promise.race([
			r.exited.then(() => "supervisor exited"),
			r.wait("child-signal", before).then((message) => String(message.signal)),
		]);
		expect(first, r.stderr()).toBe("supervisor exited");
		expect(await r.exited).toEqual([143, null]);
		expect(signalsSince(r, before)).toEqual([]);
	});

	// senpi#7525 review: an exit that lands after the supervisor first suspected its child keeps the exit's own verdict.
	it("keeps a late observed exit's verdict after the child was first suspected gone", async () => {
		const r = await rig("drain-gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		// The first re-check already saw the child gone and armed its confirmation.
		await r.wait("wait", before, (message) => message.ms === LIVENESS_RECHECK_MS);
		r.child.send({ type: "release-exit" });

		expect(await r.exited, r.stderr()).toEqual([0, null]);
		expect(r.stderr()).toContain("rpc host exited on its own idle policy");
		expect(r.stderr()).not.toContain("its exit was never observed");
		expect(signalsSince(r, before)).toEqual([]);
	});

	// senpi#7525 review: a launcher that closes the lifetime slot and replaces its image leaves a healthy host with no
	// lifetime pipe. That EOF proves nothing, and the supervisor must keep watching the host it actually runs.
	it("keeps watching a wrapped host that lost the lifetime slot, and ends once it is gone", async () => {
		const r = await rig("wrapped-gate-exit");
		await stderrIncludes(r, "closed its lifetime pipe but");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		await expireLivenessRecheck(r);
		await expireLivenessRecheck(r);

		expect(await r.exited, r.stderr()).toEqual([1, null]);
		expect(signalsSince(r, before)).toEqual([]);
	});

	// senpi#7525 review: a descendant that inherited the lifetime slot keeps it open past the host, so no EOF ever comes.
	it("notices a host that is gone while a descendant still holds its lifetime slot", async () => {
		const r = await rig("descendant-gate-exit");
		const before = r.messages.length;
		r.child.kill("SIGUSR1");
		await r.wait("exit-held", before);
		await expireLivenessRecheck(r);
		await expireLivenessRecheck(r);

		expect(await r.exited, r.stderr()).toEqual([1, null]);
		expect(signalsSince(r, before)).toEqual([]);
	});

	// senpi#7525 review: the CLI entry relaunches itself (here: isolated, for its runtime option); the host that ends up
	// serving must hold the supervisor's lifetime slot itself, not leave it with the launcher that waits on it.
	it.skipIf(process.platform !== "linux")(
		"carries the lifetime slot through the real CLI relaunch to the serving host",
		async () => {
			const r = await rig("real-chain");
			const served = execFileSync("pgrep", ["-P", String(r.hostPid)], { encoding: "utf8" })
				.split("\n")
				.map(Number)
				.filter((pid) => Number.isInteger(pid) && pid > 0);
			expect(served, "the launcher relaunched the CLI").toHaveLength(1);
			const slot = (pid: number) => {
				try {
					return readlinkSync(`/proc/${pid}/fd/3`);
				} catch {
					return "closed";
				}
			};
			expect(slot(r.hostPid)).toMatch(/^socket:/);
			expect(slot(served[0] ?? 0)).toBe(slot(r.hostPid));
		},
	);

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
