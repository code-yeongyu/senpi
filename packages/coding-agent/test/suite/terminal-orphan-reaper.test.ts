import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmOwner, killTree, reapBeforeRespawn } from "../../src/core/extensions/builtin/terminal/orphan-reaper.ts";
import {
	type ChildProcessIdentity,
	processBootAtMs,
} from "../../src/core/extensions/builtin/terminal/process-identity.ts";

const MONITOR_ID = "mon_TEST";
const RUNTIME: ChildProcessIdentity = {
	pid: 4242,
	processGroupId: 4242,
	startedAtMs: 1_790_000_000_000,
	bootAtMs: 1_789_000_000_000,
	argv: ["/bin/zsh", "-c", "tail -f build.log"],
};

type Evidence = { startedAtMs?: number; argv?: string; environ?: string };

function probes(platform: NodeJS.Platform, evidence: Evidence | undefined, alive = true) {
	return {
		platform,
		isProcessAlive: vi.fn((_pid: number) => alive),
		readProcessEvidence: vi.fn(async (_pid: number) => evidence),
		bootAtMs: () => RUNTIME.bootAtMs + 30_000,
		kill: vi.fn((_pid: number, _signal: NodeJS.Signals) => {}),
		wait: async (_ms: number) => {},
	};
}

const UNVERIFIABLE = { action: "none", reason: "previous watcher pid 4242 unverifiable" };

describe("orphan reaper", () => {
	describe("(a) confirmed owner is killed by process group", () => {
		it("darwin: start time within 2 s and exact argv", async () => {
			const p = probes("darwin", { startedAtMs: RUNTIME.startedAtMs + 900, argv: "/bin/zsh -c tail -f build.log" });
			await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("confirmed");
			await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual({ action: "killed" });
			expect(p.kill.mock.calls).toEqual([
				[-4242, "SIGTERM"],
				[-4242, "SIGKILL"],
			]);
		});

		it("darwin: the observed command contains the recorded monitor command (shell exec'd it)", async () => {
			const p = probes("darwin", { startedAtMs: RUNTIME.startedAtMs - 1_500, argv: "tail -f build.log" });
			await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("confirmed");
		});

		it("linux: env marker and start time", async () => {
			const environ = `PATH=/bin\0SENPI_MONITOR_ID=${MONITOR_ID}\0HOME=/root\0`;
			const p = probes("linux", { startedAtMs: RUNTIME.startedAtMs + 100, environ });
			await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("confirmed");
			await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual({ action: "killed" });
			expect(p.kill).toHaveBeenCalledWith(-4242, "SIGTERM");
		});

		it("linux: a background session (no monitor id in its env) is confirmed by argv", async () => {
			const p = probes("linux", {
				startedAtMs: RUNTIME.startedAtMs,
				environ: "PATH=/bin\0",
				argv: RUNTIME.argv.join(" "),
			});
			await expect(confirmOwner(RUNTIME, undefined, p)).resolves.toBe("confirmed");
		});

		it("linux: a different monitor's marker (even a prefix match) is not the owner", async () => {
			const environ = `SENPI_MONITOR_ID=${MONITOR_ID}2\0`;
			const p = probes("linux", { startedAtMs: RUNTIME.startedAtMs, environ, argv: RUNTIME.argv.join(" ") });
			await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("unverifiable");
		});
	});

	it("(b) alive but start time 10 s off -> unverifiable, no kill, reason", async () => {
		const p = probes("darwin", { startedAtMs: RUNTIME.startedAtMs + 10_000, argv: RUNTIME.argv.join(" ") });
		await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("unverifiable");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual(UNVERIFIABLE);
		expect(p.kill).not.toHaveBeenCalled();
	});

	it("(b2) alive, start time matches, argv differs -> unverifiable, no kill", async () => {
		const p = probes("darwin", { startedAtMs: RUNTIME.startedAtMs, argv: "/usr/bin/vim notes.txt" });
		await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("unverifiable");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual(UNVERIFIABLE);
		expect(p.kill).not.toHaveBeenCalled();
	});

	it("(b3) a probe that throws or has no evidence is unverifiable, never a throw", async () => {
		const throwing = {
			...probes("darwin", undefined),
			readProcessEvidence: async () => Promise.reject(new Error("ps")),
		};
		await expect(confirmOwner(RUNTIME, MONITOR_ID, throwing)).resolves.toBe("unverifiable");
		await expect(confirmOwner(RUNTIME, MONITOR_ID, probes("darwin", undefined))).resolves.toBe("unverifiable");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, throwing)).resolves.toEqual(UNVERIFIABLE);
		expect(throwing.kill).not.toHaveBeenCalled();
	});

	it("(c) ESRCH -> dead, no kill, no reason", async () => {
		const p = probes("darwin", { startedAtMs: RUNTIME.startedAtMs, argv: RUNTIME.argv.join(" ") }, false);
		await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("dead");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual({ action: "none" });
		expect(p.kill).not.toHaveBeenCalled();
	});

	it("(d) boot mismatch -> dead without probing the recycled pid", async () => {
		const p = {
			...probes("linux", { startedAtMs: RUNTIME.startedAtMs, environ: `SENPI_MONITOR_ID=${MONITOR_ID}\0` }),
			bootAtMs: () => RUNTIME.bootAtMs + 600_000,
		};
		await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("dead");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual({ action: "none" });
		expect(p.readProcessEvidence).not.toHaveBeenCalled();
		expect(p.kill).not.toHaveBeenCalled();
	});

	it("(f) win32: a confirmed owner is reported but never killed", async () => {
		const p = probes("win32", { startedAtMs: RUNTIME.startedAtMs, argv: RUNTIME.argv.join(" ") });
		await expect(confirmOwner(RUNTIME, MONITOR_ID, p)).resolves.toBe("confirmed");
		await expect(reapBeforeRespawn(RUNTIME, MONITOR_ID, p)).resolves.toEqual(UNVERIFIABLE);
		expect(p.kill).not.toHaveBeenCalled();
	});

	describe("killTree", () => {
		it("signals the bare pid when no process group is known and skips SIGKILL once it is gone", async () => {
			const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {});
			const wait = vi.fn(async (_ms: number) => {});
			const result = await killTree(
				{ ...RUNTIME, processGroupId: undefined },
				{ kill, wait, isProcessAlive: () => false },
			);
			expect(result).toEqual({ action: "killed" });
			expect(kill.mock.calls).toEqual([[4242, "SIGTERM"]]);
			expect(wait).toHaveBeenCalledWith(1000);
		});

		it("reports already-dead when SIGTERM hits ESRCH", async () => {
			const kill = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			});
			await expect(killTree(RUNTIME, { kill, wait: async () => {} })).resolves.toEqual({ action: "already-dead" });
			expect(kill).toHaveBeenCalledTimes(1);
		});
	});

	describe("(e) real process", () => {
		let child: ChildProcess | undefined;

		afterEach(() => {
			if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// already reaped
				}
			}
			child = undefined;
		});

		it.runIf(process.platform !== "win32")("confirms the real watcher and kills its tree", async () => {
			const spawned = spawn("sh", ["-c", "exec sleep 60"], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, SENPI_MONITOR_ID: MONITOR_ID },
			});
			child = spawned;
			const pid = spawned.pid;
			if (pid === undefined) throw new Error("spawn produced no pid");
			// After `exec` the process image is `sleep 60`, which is what ps and /proc/<pid>/cmdline report.
			const runtime: ChildProcessIdentity = {
				pid,
				processGroupId: pid,
				startedAtMs: Date.now(),
				bootAtMs: processBootAtMs(),
				argv: ["sleep", "60"],
			};
			await new Promise<void>((resolve) => spawned.once("spawn", () => resolve()));

			await expect(confirmOwner(runtime, MONITOR_ID)).resolves.toBe("confirmed");
			await expect(confirmOwner(runtime, "mon_OTHER")).resolves.toBe(
				process.platform === "linux" ? "unverifiable" : "confirmed",
			);

			const exited = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("child did not exit within 2 s")), 2_000);
				spawned.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			const killed = killTree(runtime, { graceMs: 100 });
			await exited;
			expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
			await expect(killed).resolves.toEqual({ action: "killed" });
		});
	});
});
