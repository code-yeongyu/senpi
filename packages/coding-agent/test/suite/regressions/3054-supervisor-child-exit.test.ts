import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processStartTimeMs, readProcessStartTime } from "../../../src/modes/app-server/daemon/process.ts";
import { readHostCrashRecords } from "../../../src/modes/rpc/host-crash-record.ts";
import {
	createDaemonDirectories,
	createHostDaemonPaths,
	generationPaths,
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
import { processExitEvent } from "../../helpers/process-exit-event.ts";
import { type GenerationScratch, generationEnv, generationScratch } from "../../helpers/rpc-generation-support.ts";
import { processAlive } from "../../helpers/spawned-host-reaper.ts";

const fixture = join(import.meta.dirname, "../../fixtures/rpc-child-exit-supervisor.ts");
const rigs: Array<{ child: ChildProcess; exited: Promise<unknown>; hostPid: number; qa: GenerationScratch }> = [];

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
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	if (!child.pid || !child.stderr) throw new Error("supervisor did not start");
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const exited = once(child, "exit");
	const messages: Record<string, unknown>[] = [];
	child.on("message", (message: unknown) => {
		if (typeof message === "object" && message !== null) messages.push({ ...message });
	});
	const wait = async (type: string, after = 0): Promise<Record<string, unknown>> => {
		const existing = () => messages.slice(after).find((message) => message.type === type);
		const found = existing();
		if (found) return found;
		return await new Promise((resolve, reject) => {
			const finish = (value?: Record<string, unknown>, error?: Error) => {
				clearTimeout(timer);
				child.off("message", onMessage);
				child.off("exit", onExit);
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
		});
	};
	const host = await wait("host");
	if (typeof host.pid !== "number") throw new Error("missing host pid");
	rigs.push({ child, exited, hostPid: host.pid, qa });
	await wait("ready");
	if (mode === "honour-term") await wait("host-ready");
	await writeHostRegistration(paths, {
		record: { pid: child.pid, processStartTime: (await readProcessStartTime(child.pid)) ?? null },
		socket: qa.socket,
		instanceId,
		generation: 0,
		launchProfileId: "child-exit-test",
	});
	return { qa, paths, generation, child, exited, wait, messages, hostPid: host.pid, stderr: () => stderr };
}

afterEach(async () => {
	for (const r of rigs.splice(0)) {
		if (r.child.exitCode === null && r.child.signalCode === null) {
			r.child.kill("SIGKILL");
			await r.exited;
		}
		if (processAlive(r.hostPid)) {
			const command = execFileSync("ps", ["-p", String(r.hostPid), "-o", "command="], { encoding: "utf8" });
			expect(command).toContain(fixture);
			const exit = await processExitEvent(r.hostPid);
			try {
				process.kill(r.hostPid, "SIGKILL");
				await exit.wait(10_000, command.trim());
			} finally {
				await exit.dispose();
			}
		}
		await rm(r.qa.root, { recursive: true, force: true });
	}
});

// #3054: observe the real supervisor's exit, its child's reaping, and the retained ownership boundary.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("supervisor child exit", () => {
	it("stops a SIGTERM-honouring host well before the escalation grace", async () => {
		const r = await rig("honour-term");
		const hostExit = await processExitEvent(r.hostPid);
		const before = r.messages.length;
		try {
			const started = performance.now();
			r.child.kill("SIGTERM");
			expect(await r.exited).toEqual([143, null]);
			const elapsedMs = performance.now() - started;
			expect(elapsedMs).toBeLessThan(3_000);
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
		expect(await r.exited).toEqual([143, null]);
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
		expect(await r.exited).toEqual([143, null]);
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
	it.each(["same", "reused", "unreadable"] as const)(
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
					identity === "unreadable"
						? null
						: new Date(startMs - (identity === "reused" ? 60_000 : 0)).toISOString(),
			});
			if (identity === "reused") {
				expect(await hostChildAlive(r.generation), "reused PID must not guard the old generation").toBe(false);
				expect(await anyGenerationLive(r.paths)).toBe(false);
				expect((await pruneDeadGenerations(r.paths)).generations, "reused PID generation must be released").toEqual(
					["child-exit"],
				);
				await expect(access(r.paths.pointerFile)).rejects.toMatchObject({ code: "ENOENT" });
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
		r.child.send({ type: "release-exit" });
		await r.exited;
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
