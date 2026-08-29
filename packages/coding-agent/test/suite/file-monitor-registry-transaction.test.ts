import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FileMonitorRegistrationError,
	FileMonitorRegistry,
} from "../../src/core/extensions/builtin/terminal/file-monitor-registry.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";
import { createKillBashTool } from "../../src/core/extensions/builtin/terminal/tools/kill-bash.ts";

function registration(path: string) {
	return {
		description: "transactional registration",
		path,
		event: "create" as const,
		timeoutMs: 5000,
	};
}

describe("native file monitor registration transaction", () => {
	afterEach(() => vi.useRealTimers());

	it("does not resurrect a record after a synchronous watcher error", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const close = vi.fn();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: vi.fn(),
			watch: () => ({
				close,
				on: (_event, listener) => {
					listener(new Error("sync watcher failure"));
					return { close, on: vi.fn() };
				},
			}),
		});

		try {
			expect(() => registry.register(registration(join(dir, "claim.json")))).toThrow(FileMonitorRegistrationError);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledOnce();
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("closes the watcher when attaching the error listener throws", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const close = vi.fn();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: vi.fn(),
			watch: () => ({
				close,
				on: () => {
					throw new Error("listener attach failure");
				},
			}),
		});

		try {
			expect(() => registry.register(registration(join(dir, "claim.json")))).toThrow(FileMonitorRegistrationError);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledOnce();
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rolls back the record, timer, and watcher when state publication throws", async () => {
		vi.useFakeTimers();
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const close = vi.fn();
		const published: string[][] = [];
		let registry: FileMonitorRegistry;
		registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: () => {
				published.push(registry.snapshot().map((entry) => entry.id));
				if (published.length === 1) throw new Error("state publication failure");
			},
			watch: () => ({ close, on: () => ({ close, on: vi.fn() }) }),
		});

		try {
			expect(() => registry.register(registration(join(dir, "claim.json")))).toThrow(FileMonitorRegistrationError);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			expect(published).toEqual([["watch_1"], []]);
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("normalizes non-Error publication failures and still rolls back", async () => {
		vi.useFakeTimers();
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const close = vi.fn();
		let publications = 0;
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: () => {
				publications += 1;
				if (publications === 1) throw "state publication failure";
			},
			watch: () => ({ close, on: () => ({ close, on: vi.fn() }) }),
		});

		try {
			let registrationError: unknown;
			try {
				registry.register(registration(join(dir, "claim.json")));
			} catch (error) {
				registrationError = error;
			}

			expect(registrationError).toBeInstanceOf(FileMonitorRegistrationError);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
			expect(publications).toBe(2);
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("clears the timer and rollback state even when watcher close throws", async () => {
		vi.useFakeTimers();
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const published: string[][] = [];
		let registry: FileMonitorRegistry;
		registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: () => {
				published.push(registry.snapshot().map((entry) => entry.id));
				if (published.length === 1) throw new Error("state publication failure");
			},
			watch: () => ({
				close: () => {
					throw new Error("close failure");
				},
				on: () => ({ close: vi.fn(), on: vi.fn() }),
			}),
		});

		try {
			expect(() => registry.register(registration(join(dir, "claim.json")))).toThrow(FileMonitorRegistrationError);
			expect(registry.snapshot()).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
			expect(published).toEqual([["watch_1"], []]);
		} finally {
			expect(() => registry.dispose()).not.toThrow();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("settles every native monitor before reporting batch cancellation errors", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const close = vi.fn();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: (id) => {
				if (id === "watch_1") throw new Error("summary failure");
			},
			onChange: vi.fn(),
			watch: () => ({ close, on: () => ({ close, on: vi.fn() }) }),
		});

		try {
			registry.register(registration(join(dir, "first.json")));
			registry.register(registration(join(dir, "second.json")));
			await expect(registry.stopAll()).rejects.toThrow(AggregateError);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledTimes(2);
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("tears down terminal sessions even when native batch cancellation throws", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-transaction-")));
		const manager = new TerminalManager();
		const teardown = vi.spyOn(manager, "teardown");
		const registry = new MonitorRegistry(
			(event) => {
				if (event.type === "summary" && event.id === "watch_1") throw new Error("summary failure");
			},
			{
				fileMonitor: {
					watch: () => ({ close: vi.fn(), on: () => ({ close: vi.fn(), on: vi.fn() }) }),
				},
			},
		);
		registry.registerFile(registration(join(dir, "first.json")));
		registry.registerFile(registration(join(dir, "second.json")));

		try {
			await expect(
				createKillBashTool({
					manager,
					monitorRegistry: registry,
					cwd: dir,
					defaultCols: 120,
					defaultRows: 40,
					getEnv: () => ({ ...process.env }),
				}).execute("kill-all-after-error", { all: true }),
			).rejects.toThrow(AggregateError);
			expect(registry.snapshot()).toEqual([]);
			expect(teardown).toHaveBeenCalledOnce();
		} finally {
			registry.dispose();
			await manager.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
