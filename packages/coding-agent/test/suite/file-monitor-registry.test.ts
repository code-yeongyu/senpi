import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import type { MonitorInput } from "../../src/core/extensions/builtin/terminal/tools/monitor.ts";
import { createNativeFileMonitorHarness } from "./native-file-monitor-harness.ts";

describe("native file monitor registry", () => {
	let manager: TerminalManager;

	beforeEach(() => {
		manager = new TerminalManager();
	});

	afterEach(async () => {
		await manager.teardown();
	});

	it("reconciles the target when native filename metadata does not match", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "DONECLAIM.json");
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			const result = await harness.tool.execute("monitor-mismatched-filename", {
				description: "filename hint",
				path: target,
				event: "create",
			} as MonitorInput);
			expect(result.isError).not.toBe(true);
			expect(harness.watcher()).toBeDefined();

			await writeFile(target, "{}");
			harness.watcher()?.emit("doneclaim.json");
			await Promise.resolve();

			expect(harness.events).toEqual([
				expect.objectContaining({ type: "line", line: `created ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
			expect(harness.registry.snapshot()).toEqual([]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("coalesces a native watcher burst into one queued reconciliation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "burst.json");
		const queued: Array<() => void> = [];
		const harness = createNativeFileMonitorHarness(manager, dir, {
			queueReconcile: (callback) => queued.push(callback),
		});

		try {
			await harness.tool.execute("monitor-burst", {
				description: "event burst",
				path: target,
				event: "create",
			} as MonitorInput);
			for (let index = 0; index < 100; index += 1) harness.watcher()?.emit("burst.json");

			expect(queued).toHaveLength(1);
			await writeFile(target, "{}");
			queued[0]?.();
			expect(harness.events).toEqual([
				expect.objectContaining({ type: "line", line: `created ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("settles modify only after the inspected fingerprint changes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "verdict.json");
		await writeFile(target, '{"verdict":"pending"}');
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			await harness.tool.execute("monitor-modify-fingerprint", {
				description: "modify fingerprint",
				path: target,
				event: "modify",
			} as MonitorInput);
			harness.watcher()?.emit("unrelated-name.json");
			expect(harness.events).toEqual([]);
			expect(harness.registry.snapshot()).toHaveLength(1);

			await writeFile(target, '{"verdict":"confirmed"}');
			harness.watcher()?.emit("another-name.json");
			await Promise.resolve();
			expect(harness.events).toEqual([
				expect.objectContaining({ type: "line", line: `modified ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
			expect(harness.registry.snapshot()).toEqual([]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("publishes one disposal state and ignores queued callbacks after disposal", async () => {
		vi.useFakeTimers();
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "disposed.json");
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			await harness.tool.execute("monitor-dispose", {
				description: "dispose watch",
				path: target,
				event: "create",
				timeout_ms: 500,
			} as MonitorInput);
			const watcher = harness.watcher();
			expect(watcher).toBeDefined();
			harness.snapshots.length = 0;

			harness.registry.dispose();
			expect(harness.snapshots).toEqual([[]]);
			expect(watcher?.close).toHaveBeenCalledOnce();

			await writeFile(target, "{}");
			watcher?.emit("disposed.json");
			watcher?.fail(new Error("queued error"));
			vi.advanceTimersByTime(500);
			expect(harness.events).toEqual([]);
		} finally {
			harness.registry.dispose();
			vi.useRealTimers();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps event and path context in a paused completion summary", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "paused.json");
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			await harness.tool.execute("monitor-paused-file", {
				description: "paused watch",
				path: target,
				event: "create",
			} as MonitorInput);
			expect(harness.registry.pauseAll()).toEqual(["watch_1"]);

			await writeFile(target, "{}");
			harness.watcher()?.emit("paused.json");
			await Promise.resolve();

			expect(harness.events).toEqual([
				expect.objectContaining({
					type: "summary",
					summary: expect.stringContaining(`created ${target}`),
				}),
			]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects directory entries instead of completing file watches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "not-a-file.json");
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			await harness.tool.execute("monitor-directory", {
				description: "directory watch",
				path: target,
				event: "create",
			} as MonitorInput);
			await mkdir(target);
			harness.watcher()?.emit("not-a-file.json");
			await Promise.resolve();

			expect(harness.events).toEqual([
				expect.objectContaining({
					type: "summary",
					summary: expect.stringContaining("not a regular file"),
				}),
			]);
			expect(harness.registry.snapshot()).toEqual([]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects target symlinks without following their referent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const external = await mkdtemp(join(tmpdir(), "senpi-file-monitor-external-"));
		const target = join(dir, "linked.json");
		const referent = join(external, "secret.json");
		await writeFile(referent, "{}");
		const harness = createNativeFileMonitorHarness(manager, dir);

		try {
			await harness.tool.execute("monitor-target-symlink", {
				description: "target symlink",
				path: target,
				event: "create",
			} as MonitorInput);
			await symlink(referent, target);
			harness.watcher()?.emit("linked.json");
			await Promise.resolve();

			expect(harness.events).toEqual([
				expect.objectContaining({
					type: "summary",
					summary: expect.stringContaining("not a regular file"),
				}),
			]);
			expect(harness.registry.snapshot()).toEqual([]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
			await rm(external, { recursive: true, force: true });
		}
	});

	it("reconciles a file created while the native watcher attaches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-file-monitor-"));
		const target = join(dir, "raced.json");
		const order: string[] = [];
		const harness = createNativeFileMonitorHarness(manager, dir, {
			beforeWatchReturn: () => {
				writeFileSync(target, "{}");
			},
			onEvent: (event) => order.push(event.type),
			onMonitorRearmed: (id) => order.push(`rearm:${id}`),
		});

		try {
			await harness.tool.execute("monitor-registration-race", {
				description: "registration race",
				path: target,
				event: "create",
			} as MonitorInput);
			expect(harness.events).toEqual([
				expect.objectContaining({ type: "line", line: `created ${target}` }),
				expect.objectContaining({ type: "summary", summary: expect.stringContaining("completed") }),
			]);
			expect(order).toEqual(["rearm:watch_1", "line", "summary"]);
		} finally {
			harness.registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects completion after the approved logical parent is retargeted", async () => {
		const workspace = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-workspace-")));
		const approved = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-approved-")));
		const replacement = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-replacement-")));
		const link = join(workspace, "link");
		const logicalTarget = join(link, "claim.json");
		await symlink(approved, link);
		const input = {
			description: "logical retarget",
			path: logicalTarget,
			event: "create",
		} as MonitorInput;
		createBuiltinParserRegistry().parse("monitor", input, workspace);
		const harness = createNativeFileMonitorHarness(manager, workspace);

		try {
			const started = await harness.tool.execute("monitor-logical-retarget", input);
			expect(started.isError).not.toBe(true);
			await unlink(link);
			await symlink(replacement, link);
			await writeFile(join(approved, "claim.json"), "{}");
			harness.watcher()?.emit("claim.json");
			await Promise.resolve();

			expect(harness.events).toEqual([
				expect.objectContaining({
					type: "summary",
					summary: expect.stringContaining("approved monitor parent changed"),
				}),
			]);
			expect(harness.registry.snapshot()).toEqual([]);
		} finally {
			harness.registry.dispose();
			await rm(workspace, { recursive: true, force: true });
			await rm(approved, { recursive: true, force: true });
			await rm(replacement, { recursive: true, force: true });
		}
	});
});
