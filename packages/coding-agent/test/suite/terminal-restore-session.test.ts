import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { acquireTerminalLease, currentLeaseToken } from "../../src/core/extensions/builtin/terminal/manifest-lease.ts";
import { processBootAtMs } from "../../src/core/extensions/builtin/terminal/process-identity.ts";
import { readProcessStartMs } from "../../src/core/extensions/builtin/terminal/process-start-probe.ts";
import { RESTORE_DIGEST_CUSTOM_TYPE } from "../../src/core/extensions/builtin/terminal/restore-digest.ts";
import {
	restoreSessionTestHooks,
	whenRestoreDecided,
} from "../../src/core/extensions/builtin/terminal/restore-session.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import {
	createSessionGeneration,
	firstText,
	type SentMessage,
	type SessionGeneration,
} from "./terminal-restore-session-harness.ts";

const leaseFaults = vi.hoisted(() => ({ failNextAcquires: 0 }));

vi.mock("../../src/core/extensions/builtin/terminal/manifest-lease.ts", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../src/core/extensions/builtin/terminal/manifest-lease.ts")>();
	return {
		...original,
		acquireTerminalLease: (...args: Parameters<typeof original.acquireTerminalLease>) => {
			if (leaseFaults.failNextAcquires > 0) {
				leaseFaults.failNextAcquires -= 1;
				return Promise.reject(new Error("terminal lease kept changing while it was being acquired"));
			}
			return original.acquireTerminalLease(...args);
		},
	};
});

interface DigestDetails {
	outcome: string;
	monitors: Array<{ monitorId: string; outcome: string; reason?: string; orphan?: { pid: number; action: string } }>;
}

function digests(generation: SessionGeneration): SentMessage[] {
	return generation.sent.filter((entry) => entry.message.customType === RESTORE_DIGEST_CUSTOM_TYPE);
}

function detailsOf(entry: SentMessage | undefined): DigestDetails {
	return (entry?.message.details ?? { outcome: "none", monitors: [] }) as DigestDetails;
}

function heldStatus(generation: SessionGeneration): string | undefined {
	return generation.statuses.map(([, text]) => text).find((text) => text?.includes("held by pid"));
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.runIf(process.platform !== "win32")("terminal restore session: lease, keeper, orphan, one digest", () => {
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;
	const savedAgentDir = process.env.SENPI_CODING_AGENT_DIR;
	let tmp: string;
	let cwd: string;
	let sessionDir: string;
	let stateDir: string;
	let sessionId: string;
	let live: SessionGeneration[];
	let children: ChildProcess[];
	let counter = 0;

	beforeEach(() => {
		initTheme("dark");
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		tmp = mkdtempSync(join(tmpdir(), "senpi-restore-session-"));
		process.env.SENPI_CODING_AGENT_DIR = join(tmp, "agent-home");
		cwd = join(tmp, "project");
		sessionDir = join(tmp, "sessions");
		mkdirSync(join(cwd, ".senpi"), { recursive: true });
		sessionId = `restore-session-${Date.now().toString(36)}-${++counter}`;
		stateDir = join(sessionDir, "extensions", "terminal");
		live = [];
		children = [];
		restoreSessionTestHooks.keeperIntervalMs = 50;
		// The production grace: a shorter one lets a loaded host's shell start-up outlast the window,
		// so a script that exits 127 would read as still running.
		restoreSessionTestHooks.graceMs = 2_000;
	});

	afterEach(async () => {
		for (const generation of live)
			await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		for (const child of children) child.kill("SIGKILL");
		restoreSessionTestHooks.keeperIntervalMs = undefined;
		restoreSessionTestHooks.graceMs = undefined;
		rmSync(tmp, { recursive: true, force: true });
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		if (savedAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
		else process.env.SENPI_CODING_AGENT_DIR = savedAgentDir;
	});

	const encoded = () => encodeURIComponent(sessionId);
	const leasePath = () => join(stateDir, `${encoded()}.lease`);
	const manifestPath = () => join(stateDir, `${encoded()}.json`);

	function build(options: { mode?: string; withModel?: boolean } = {}): SessionGeneration {
		const generation = createSessionGeneration({ cwd, sessionId, sessionDir, ...options });
		registerTerminalExtension(generation.pi);
		live.push(generation);
		return generation;
	}

	async function start(reason: string, options: { mode?: string; withModel?: boolean } = {}) {
		const generation = build(options);
		await generation.emit("session_start", { type: "session_start", reason });
		return generation;
	}

	function writeManifest(monitors: Array<Record<string, unknown>>): void {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			manifestPath(),
			JSON.stringify({ version: 1, sessionId, monitors, backgroundSessions: [], updatedAt: Date.now() - 60_000 }),
		);
	}

	function persistedWatch(monitorId: string, command: string): Record<string, unknown> {
		const now = Date.now();
		return {
			monitorId,
			sessionId,
			description: `watch ${monitorId}`,
			runtimeKind: "command",
			durabilityClass: "restartable-command",
			command,
			cwd,
			createdAt: now - 120_000,
			expiresAt: now + 86_400_000,
			persistent: true,
			suspended: true,
			lastCheckpoint: null,
			deliveryPaused: false,
			fireWindow: { startMs: now - 120_000, count: 0 },
		};
	}

	/** A live unrelated process to stand in as the foreign holder; `startedAtMs` is its real or a forged start. */
	async function foreignHolderLease(options: { forgeStart?: boolean } = {}): Promise<ChildProcess> {
		const child = spawn("sleep", ["300"], { stdio: "ignore" });
		children.push(child);
		const pid = child.pid ?? 0;
		const realStart = (await readProcessStartMs(pid)) ?? Date.now();
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			leasePath(),
			JSON.stringify({
				v: 2,
				token: "foreign-token",
				pid,
				startedAtMs: Date.now(),
				acquiredAtMs: Date.now(),
				bootAtMs: processBootAtMs(),
				processStartedAtMs: options.forgeStart ? realStart - 3_600_000 : realStart,
			}),
		);
		return child;
	}

	async function exited(child: ChildProcess): Promise<void> {
		if (child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	}

	it("(a) a crash leaves the watcher running; the next process stops it, re-spawns once, and reports it", async () => {
		const first = await start("startup");
		const created = await first.tools.get("monitor")?.execute("tick", {
			description: "ticker",
			command: "while true; do echo tick; sleep 1; done",
			persistent: true,
		});
		expect(created?.isError, firstText(created)).toBeFalsy();
		const monitorId = String(created?.details?.monitor_id);
		const saved = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
			monitors: Array<{ monitorId: string; runtime?: { pid: number } }>;
		};
		const oldPid = saved.monitors.find((entry) => entry.monitorId === monitorId)?.runtime?.pid ?? 0;
		expect(isAlive(oldPid)).toBe(true);
		live = live.filter((generation) => generation !== first);
		// A crash, as the next process sees it: the lease names a pid that no longer exists.
		const dead = spawn("true", { stdio: "ignore" });
		await exited(dead);
		const lease = JSON.parse(readFileSync(leasePath(), "utf8")) as Record<string, unknown>;
		writeFileSync(leasePath(), JSON.stringify({ ...lease, pid: dead.pid, token: "crashed-process-token" }));

		const second = await start("startup");
		await whenRestoreDecided(sessionId);
		expect(digests(second)).toHaveLength(1);
		expect(detailsOf(digests(second)[0]).monitors).toEqual([
			expect.objectContaining({ monitorId, outcome: "restored", orphan: { pid: oldPid, action: "killed" } }),
		]);
		expect(isAlive(oldPid)).toBe(false);
	});

	it("(a2) two crashes in a row still leave exactly one watcher: the restore records the new process", async () => {
		const crash = async (): Promise<void> => {
			const dead = spawn("true", { stdio: "ignore" });
			await exited(dead);
			const lease = JSON.parse(readFileSync(leasePath(), "utf8")) as Record<string, unknown>;
			writeFileSync(leasePath(), JSON.stringify({ ...lease, pid: dead.pid, token: `crashed-${dead.pid}` }));
		};
		const runtimePid = (monitorId: string): number => {
			const saved = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
				monitors: Array<{ monitorId: string; runtime?: { pid: number } }>;
			};
			return saved.monitors.find((entry) => entry.monitorId === monitorId)?.runtime?.pid ?? 0;
		};
		const first = await start("startup");
		const created = await first.tools.get("monitor")?.execute("tick", {
			description: "ticker",
			command: "while true; do echo tick; sleep 1; done",
			persistent: true,
		});
		const monitorId = String(created?.details?.monitor_id);
		const originalPid = runtimePid(monitorId);
		live = live.filter((generation) => generation !== first);
		await crash();

		const second = await start("startup");
		await whenRestoreDecided(sessionId);
		const respawnedPid = runtimePid(monitorId);
		expect(respawnedPid).not.toBe(originalPid);
		expect(isAlive(respawnedPid)).toBe(true);
		live = live.filter((generation) => generation !== second);
		await crash();

		const third = await start("startup");
		await whenRestoreDecided(sessionId);
		expect(detailsOf(digests(third)[0]).monitors).toEqual([
			expect.objectContaining({ monitorId, outcome: "restored", orphan: { pid: respawnedPid, action: "killed" } }),
		]);
		expect(isAlive(respawnedPid)).toBe(false);
	});

	it("(a3) a watch that did not come back is gone from the manifest: a second restart never re-runs it", async () => {
		const runs = join(tmp, "runs.log");
		writeManifest([persistedWatch("mon_COMPLETEDONCE01", `echo run >> '${runs}'`)]);
		const first = await start("resume");
		await whenRestoreDecided(sessionId);
		expect(detailsOf(digests(first)[0]).monitors.map((entry) => entry.outcome)).toEqual(["completed"]);
		expect(existsSync(manifestPath())).toBe(false);
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = live.filter((generation) => generation !== first);

		const second = await start("resume");
		await whenRestoreDecided(sessionId);
		expect(digests(second)).toEqual([]);
		expect(readFileSync(runs, "utf8").trim().split("\n")).toEqual(["run"]);
	});

	it("(b) a live foreign holder defers the restore; its exit hands the session over with exactly one digest", async () => {
		writeManifest([persistedWatch("mon_TAKEOVER00000001", "cat")]);
		const holder = await foreignHolderLease();
		const generation = await start("resume");
		expect(heldStatus(generation)).toContain(`held by pid ${holder.pid}`);
		expect(digests(generation).filter((entry) => detailsOf(entry).outcome === "decided")).toEqual([]);

		holder.kill("SIGKILL");
		await exited(holder);
		await whenRestoreDecided(sessionId);
		const decided = digests(generation).filter((entry) => detailsOf(entry).outcome === "decided");
		expect(decided).toHaveLength(1);
		expect(detailsOf(decided[0]).monitors).toEqual([
			expect.objectContaining({ monitorId: "mon_TAKEOVER00000001", outcome: "restored" }),
		]);
	});

	it("(c) a lease whose pid was reused by an unrelated process is reclaimed at once", async () => {
		writeManifest([persistedWatch("mon_PIDREUSED000001", "cat")]);
		await foreignHolderLease({ forgeStart: true });
		const generation = await start("resume");
		await whenRestoreDecided(sessionId);
		expect(heldStatus(generation)).toBeUndefined();
		expect(detailsOf(digests(generation)[0]).monitors[0]).toMatchObject({ outcome: "restored" });
	});

	it("(d) a watch whose script is gone is lost with its non-zero exit code; lost and expired state dirs are removed", async () => {
		const expired = { ...persistedWatch("mon_EXPIREDWATCH001", "cat"), expiresAt: Date.now() - 1_000 };
		writeManifest([persistedWatch("mon_MISSINGSCRIPT01", `sh ${join(tmp, "missing.sh")}`), expired]);
		const stateDirOf = (monitorId: string) => join(stateDir, "state", monitorId);
		for (const monitorId of ["mon_MISSINGSCRIPT01", "mon_EXPIREDWATCH001"]) {
			mkdirSync(stateDirOf(monitorId), { recursive: true });
			writeFileSync(join(stateDirOf(monitorId), "base"), "baseline");
		}
		const generation = await start("resume");
		await whenRestoreDecided(sessionId);
		expect(detailsOf(digests(generation)[0]).monitors.map((entry) => [entry.monitorId, entry.outcome])).toEqual([
			["mon_MISSINGSCRIPT01", "lost"],
			["mon_EXPIREDWATCH001", "expired"],
		]);
		expect(detailsOf(digests(generation)[0]).monitors[0]).toMatchObject({
			reason: expect.stringMatching(/^exited [1-9]\d* in \d+ms: .*missing\.sh/),
		});
		expect(existsSync(stateDirOf("mon_MISSINGSCRIPT01"))).toBe(false);
		expect(existsSync(stateDirOf("mon_EXPIREDWATCH001"))).toBe(false);
		expect(digests(generation)[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});

	it("(e) two processes racing for one session: exactly one acquires the lease", async () => {
		mkdirSync(stateDir, { recursive: true });
		const script = `import { acquireTerminalLease } from ${JSON.stringify(join(import.meta.dirname, "../../src/core/extensions/builtin/terminal/manifest-lease.ts"))};
const r = await acquireTerminalLease({ dir: process.argv[1], encodedSessionId: process.argv[2] });
console.log(JSON.stringify({ acquired: r.acquired }));
await new Promise((resolve) => setTimeout(resolve, 3000));`;
		const other = spawn(
			process.execPath.includes("bun") ? process.execPath : "bun",
			["-e", script, stateDir, encoded()],
			{
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
		children.push(other);
		const [mine, theirs] = await Promise.all([
			acquireTerminalLease({ dir: stateDir, encodedSessionId: encoded() }),
			new Promise<{ acquired: boolean }>((resolve) => {
				other.stdout?.once("data", (chunk: Buffer) =>
					resolve(JSON.parse(chunk.toString()) as { acquired: boolean }),
				);
			}),
		]);
		expect([mine.acquired, theirs.acquired].filter(Boolean)).toHaveLength(1);
	});

	it("(f) with no model bound yet the decided digest waits, then arrives once on model_select", async () => {
		writeManifest([persistedWatch("mon_NOMODELYET00001", "cat")]);
		const generation = await start("resume", { withModel: false });
		await whenRestoreDecided(sessionId);
		expect(digests(generation)).toEqual([]);
		const model = { id: "test-model", api: "openai-completions" };
		generation.setModel(model);
		await generation.emit("model_select", { type: "model_select", model });
		await generation.emit("model_select", { type: "model_select", model });
		expect(digests(generation)).toHaveLength(1);
	});

	it("(g2) an unreadable manifest is left exactly as it was (fail closed)", async () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(manifestPath(), "{not a manifest");
		const generation = await start("resume");
		await whenRestoreDecided(sessionId);
		expect(detailsOf(digests(generation)[0]).outcome).toBe("corrupt");
		expect(readFileSync(manifestPath(), "utf8")).toBe("{not a manifest");
	});

	it("(j) an acquire that fails at session start waits, then the keeper takes over and restores once", async () => {
		writeManifest([persistedWatch("mon_ACQUIREFAILS001", "cat")]);
		leaseFaults.failNextAcquires = 1;
		const generation = await start("resume");
		expect(generation.statuses.map(([, text]) => text)).toContain("monitors waiting for the session lease");
		await whenRestoreDecided(sessionId);
		const decided = digests(generation).filter((entry) => detailsOf(entry).outcome === "decided");
		expect(decided).toHaveLength(1);
		expect(detailsOf(decided[0]).monitors).toEqual([
			expect.objectContaining({ monitorId: "mon_ACQUIREFAILS001", outcome: "restored" }),
		]);
	});

	it("(g) a print-mode start restores nothing and takes no lease", async () => {
		writeManifest([persistedWatch("mon_PRINTMODE000001", "cat")]);
		const generation = await start("startup", { mode: "print" });
		expect(digests(generation)).toEqual([]);
		expect(existsSync(leasePath())).toBe(false);
	});

	it("(h) an in-process /resume restores the watches and rotates the token, never 'held by'", async () => {
		writeManifest([persistedWatch("mon_INPROCRESUME01", "cat")]);
		const generation = await start("startup");
		await whenRestoreDecided(sessionId);
		const firstToken = currentLeaseToken(encoded());
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		await generation.emit("session_start", { type: "session_start", reason: "resume" });
		await whenRestoreDecided(sessionId);
		expect(heldStatus(generation)).toBeUndefined();
		expect(currentLeaseToken(encoded())).not.toBe(firstToken);
		expect(detailsOf(digests(generation).at(-1)).monitors[0]).toMatchObject({
			monitorId: "mon_INPROCRESUME01",
			outcome: "restored",
		});
	});

	it("(h2) a lease this process never released (shutdown cut short) is re-entered, not 'held by'", async () => {
		writeManifest([persistedWatch("mon_SELFREENTRY001", "cat")]);
		const generation = await start("startup");
		await whenRestoreDecided(sessionId);
		const stale = readFileSync(leasePath(), "utf8");
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "resume" });
		writeFileSync(leasePath(), stale);
		writeManifest([persistedWatch("mon_SELFREENTRY001", "cat")]);
		await generation.emit("session_start", { type: "session_start", reason: "resume" });
		await whenRestoreDecided(sessionId);
		expect(heldStatus(generation)).toBeUndefined();
		expect(detailsOf(digests(generation).at(-1)).monitors[0]).toMatchObject({ outcome: "restored" });
	});

	it("(i) a watch created while waiting on a foreign holder is on disk after the takeover", async () => {
		writeManifest([persistedWatch("mon_WAITERBASE0001", "cat")]);
		const holder = await foreignHolderLease();
		const generation = await start("resume");
		const created = await generation.tools.get("monitor")?.execute("waiter", {
			description: "created while held",
			command: "cat",
			persistent: true,
		});
		expect(created?.isError, firstText(created)).toBeFalsy();
		holder.kill("SIGKILL");
		await exited(holder);
		await whenRestoreDecided(sessionId);
		await generation.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		live = live.filter((entry) => entry !== generation);
		const saved = JSON.parse(readFileSync(manifestPath(), "utf8")) as { monitors: Array<{ description: string }> };
		expect(saved.monitors.map((entry) => entry.description).sort()).toEqual([
			"created while held",
			"watch mon_WAITERBASE0001",
		]);
	});
});
