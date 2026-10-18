/** Exit observation and exact-PID cleanup for the real owner-lifetime scenarios. */
import { type ChildProcess, execFileSync } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { expect } from "vitest";
import { STOP_WAIT_BUDGET_MS } from "../../src/modes/rpc/host-ensure-stop.ts";
import { processExitEvent } from "./process-exit-event.ts";
import { processAlive } from "./spawned-host-reaper.ts";

const EXIT_BOUND_MS = 10_000;

export class RpcOwnerProcesses {
	private readonly owners: ChildProcess[] = [];
	private readonly pids = new Map<number, string>();
	private readonly supervisors = new Map<
		number,
		{
			pipe: Socket;
			ready: Promise<void>;
			wait: (ms: number) => Promise<void>;
			dispose: () => Promise<void>;
		}
	>();

	remember(pid: number): void {
		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
		if (!command) throw new Error(`missing command for started pid ${pid}`);
		this.pids.set(pid, command);
	}

	owner(child: ChildProcess): void {
		this.owners.push(child);
		if (child.pid === undefined) throw new Error("owner did not start");
		this.remember(child.pid);
	}

	supervisor(pid: number, pipe: Socket): void {
		const watcher = processExitEvent(pid);
		const ready = watcher.then(() => {});
		void ready.catch(() => {});
		this.remember(pid);
		pipe.resume();
		this.supervisors.set(pid, {
			pipe,
			ready,
			wait: async (ms) => (await watcher).wait(ms, this.pids.get(pid) ?? "unknown command"),
			dispose: async () => (await watcher).dispose(),
		});
	}

	successor(child: ChildProcess, pipe: Socket): void {
		if (child.pid === undefined) throw new Error("missing successor pid");
		const pid = child.pid;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		this.remember(pid);
		this.supervisors.set(pid, {
			pipe,
			ready: Promise.resolve(),
			wait: (ms) => bounded(exited, ms, `pid ${pid} (${this.pids.get(pid)})`),
			dispose: async () => {},
		});
		pipe.resume();
	}

	async ready(): Promise<void> {
		await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.ready));
	}

	async allGone(): Promise<void> {
		await Promise.all(
			this.owners.map((owner) =>
				owner.exitCode !== null || owner.signalCode !== null
					? Promise.resolve()
					: once(owner, "exit", { signal: AbortSignal.timeout(EXIT_BOUND_MS) }),
			),
		);
		await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.wait(EXIT_BOUND_MS)));
		for (const [pid, command] of this.pids)
			expect(processAlive(pid), `pid ${pid} (${command}) still alive after owner exit`).toBe(false);
	}

	async cleanup(): Promise<void> {
		try {
			for (const child of this.owners) {
				if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) continue;
				const exited = once(child, "exit", { signal: AbortSignal.timeout(15_000) });
				this.verifyCommand(child.pid);
				child.kill("SIGTERM");
				await exited;
			}
			for (const [pid, supervisor] of this.supervisors) {
				if (!processAlive(pid)) continue;
				this.verifyCommand(pid);
				process.kill(pid, "SIGTERM");
				await supervisor.wait(STOP_WAIT_BUDGET_MS);
			}
			for (const pid of this.pids.keys()) expect(processAlive(pid), `cleanup pid ${pid}`).toBe(false);
		} finally {
			// An assertion or mutant must not leak its waiter or a still-live host. Only our exact recorded PIDs.
			try {
				for (const [pid, command] of this.pids) {
					if (!processAlive(pid)) continue;
					this.verifyCommand(pid);
					const exit = await processExitEvent(pid);
					try {
						process.kill(pid, "SIGKILL");
						await exit.wait(EXIT_BOUND_MS, command);
					} finally {
						await exit.dispose();
					}
				}
			} finally {
				for (const supervisor of this.supervisors.values()) {
					await supervisor.dispose();
					supervisor.pipe.destroy();
				}
				this.supervisors.clear();
				this.owners.length = 0;
				this.pids.clear();
			}
		}
	}

	private verifyCommand(pid: number): void {
		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
		if (command !== this.pids.get(pid)) throw new Error(`refusing changed process ${pid}`);
	}
}

async function bounded(operation: Promise<void>, ms: number, label: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} still alive after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
