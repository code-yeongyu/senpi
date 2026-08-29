import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import {
	type SecureFileMonitorWorkerEvent,
	SecureFileMonitorWorkerPool,
} from "../../src/core/extensions/builtin/terminal/secure-file-monitor-worker.ts";
import { createMonitorTool, type MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";

describe("secure file monitor worker", () => {
	it("bounds worker startup when the child never becomes ready", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-startup-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool({
			startupTimeoutMs: 50,
			workerCommand: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		});

		try {
			await expect(
				pool.register({
					directory: root,
					expectedDevice: identity.dev,
					expectedInode: identity.ino,
					targetName: "claim.json",
					event: "create",
					timeoutMs: 5000,
					onEvent: () => {},
				}),
			).rejects.toThrow("did not become ready");
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an in-flight request when the worker exits", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-crash-")));
		const identity = await stat(root, { bigint: true });
		const crashSource =
			'const fs=require("node:fs");const s=fs.statSync(".",{bigint:true});console.log(JSON.stringify({type:"ready",device:String(s.dev),inode:String(s.ino)}));process.stdin.once("data",()=>process.exit(17));';
		const pool = new SecureFileMonitorWorkerPool({
			requestTimeoutMs: 500,
			workerCommand: [process.execPath, "-e", crashSource],
		});

		try {
			await expect(
				pool.register({
					directory: root,
					expectedDevice: identity.dev,
					expectedInode: identity.ino,
					targetName: "claim.json",
					event: "create",
					timeoutMs: 5000,
					onEvent: () => {},
				}),
			).rejects.toThrow("exited");
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reuses one directory worker and closes it after the last lease", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-pool-")));
		const identity = await stat(root, { bigint: true });
		const pool = new SecureFileMonitorWorkerPool();

		try {
			const first = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "first.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			const second = await pool.register({
				directory: root,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "second.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: () => {},
			});
			expect(pool.workerCount).toBe(1);

			await first.stop();
			expect(pool.workerCount).toBe(1);
			await second.stop();
			expect(pool.workerCount).toBe(0);
		} finally {
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reserves shared capacity while secure registration is pending", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-capacity-")));
		const manager = new TerminalManager();
		const registry = new MonitorRegistry(() => {}, { maxSessions: 1 });
		const tool = createMonitorTool({
			manager,
			monitorRegistry: registry,
			cwd: root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		});

		try {
			const results = await Promise.all([
				tool.execute("secure-capacity-1", {
					description: "first pending",
					path: join(root, "first.json"),
					event: "create",
				} as MonitorInput),
				tool.execute("secure-capacity-2", {
					description: "second pending",
					path: join(root, "second.json"),
					event: "create",
				} as MonitorInput),
			]);
			expect(results.filter((result) => result.isError)).toHaveLength(1);
			expect(registry.snapshot()).toHaveLength(1);
		} finally {
			await registry.teardown();
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rolls back secure state publication failures", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-rollback-")));
		const manager = new TerminalManager();
		let publications = 0;
		const registry = new MonitorRegistry(() => {}, {
			onChange: () => {
				publications += 1;
				if (publications === 1) throw new Error("secure publication failure");
			},
		});
		const tool = createMonitorTool({
			manager,
			monitorRegistry: registry,
			cwd: root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		});

		try {
			const result = await tool.execute("secure-rollback", {
				description: "secure rollback",
				path: join(root, "claim.json"),
				event: "create",
			} as MonitorInput);
			expect(result.isError).toBe(true);
			expect(registry.snapshot()).toEqual([]);
			expect(publications).toBe(2);
		} finally {
			await registry.teardown();
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps target inspection anchored across parent ABA replacement", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-")));
		const approved = join(root, "approved");
		const moved = join(root, "moved");
		const external = join(root, "external");
		await mkdir(approved);
		await mkdir(external);
		const identity = await stat(approved, { bigint: true });
		const events: SecureFileMonitorWorkerEvent[] = [];
		const pool = new SecureFileMonitorWorkerPool();
		let stop: (() => Promise<void>) | undefined;

		try {
			const registration = await pool.register({
				directory: approved,
				expectedDevice: identity.dev,
				expectedInode: identity.ino,
				targetName: "claim.json",
				event: "create",
				timeoutMs: 5000,
				onEvent: (event) => events.push(event),
			});
			stop = registration.stop;

			await rename(approved, moved);
			await symlink(external, approved);
			await writeFile(join(external, "claim.json"), "external-secret");
			await registration.reconcile();
			expect(events).toEqual([]);

			await writeFile(join(moved, "claim.json"), "approved");
			await registration.reconcile();
			expect(events).toEqual([{ type: "created" }]);
		} finally {
			await stop?.();
			await pool.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.each([
		{ event: "create" as const, initial: undefined, next: "created" },
		{ event: "modify" as const, initial: "before", next: "after" },
	])("completes a real production $event monitor", async ({ event, initial, next }) => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "senpi-secure-monitor-production-")));
		const target = join(root, "claim.json");
		if (initial !== undefined) await writeFile(target, initial);
		const manager = new TerminalManager();
		const events: MonitorEvent[] = [];
		const completed = Promise.withResolvers<void>();
		const registry = new MonitorRegistry((monitorEvent) => {
			events.push(monitorEvent);
			if (monitorEvent.type === "summary" && monitorEvent.summary.includes("completed")) completed.resolve();
		});
		const tool = createMonitorTool({
			manager,
			monitorRegistry: registry,
			cwd: root,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		});
		const deadline = setTimeout(() => completed.reject(new Error(`production ${event} monitor timed out`)), 5000);

		try {
			const started = await tool.execute("secure-production", {
				description: `secure ${event}`,
				path: target,
				event,
			} as MonitorInput);
			expect(started.isError).toBeFalsy();
			await writeFile(target, next);
			await completed.promise;
			expect(events).toEqual([
				expect.objectContaining({ type: "line", line: `${event === "create" ? "created" : "modified"} ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
			expect(registry.snapshot()).toEqual([]);
		} finally {
			clearTimeout(deadline);
			registry.dispose();
			await manager.teardown();
			await rm(root, { recursive: true, force: true });
		}
	});
});
