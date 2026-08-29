import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FileMonitorRegistrationError,
	FileMonitorRegistry,
} from "../../src/core/extensions/builtin/terminal/file-monitor-registry.ts";
import { nativeFileMonitorPoll } from "../../src/core/extensions/builtin/terminal/file-monitor-runtime.ts";

describe("native file monitor stat fallback", () => {
	afterEach(() => vi.useRealTimers());

	it.each([
		{ event: "create" as const, initial: undefined, next: "created" },
		{ event: "modify" as const, initial: "before", next: "after replacement with a different size" },
	])("detects $event when the native watcher emits no event", async ({ event, initial, next }) => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-fallback-")));
		const target = join(dir, "artifact.json");
		if (initial !== undefined) await writeFile(target, initial);
		const close = vi.fn();
		const stopPolling = vi.fn();
		const emitLine = vi.fn();
		const emitSummary = vi.fn();
		let poll: (() => void) | undefined;
		const registry = new FileMonitorRegistry({
			emitLine,
			emitSummary,
			onChange: vi.fn(),
			poll: (_path, options, listener) => {
				expect(options).toEqual({ interval: 1000, persistent: false });
				poll = listener;
				return stopPolling;
			},
			watch: (_path, options) => {
				expect(options).toEqual({ encoding: "utf8", persistent: false });
				return { close, on: () => ({ close, on: vi.fn() }) };
			},
		});

		try {
			registry.register({
				description: `${event} without native event`,
				path: target,
				event,
				timeoutMs: 5000,
			});
			await writeFile(target, next);
			const pollListener = poll;
			if (!pollListener) throw new Error("Expected stat fallback listener");
			pollListener();

			expect(emitLine).toHaveBeenCalledWith(
				"watch_1",
				`${event} without native event`,
				`${event === "create" ? "created" : "modified"} ${target}`,
			);
			expect(emitSummary).toHaveBeenCalledWith(
				"watch_1",
				`${event} without native event`,
				expect.stringContaining("watcher completed"),
			);
			expect(registry.snapshot()).toEqual([]);
			expect(close).toHaveBeenCalledOnce();
			expect(stopPolling).toHaveBeenCalledOnce();
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("observes a real file modification through the native poll adapter", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-native-poll-")));
		const target = join(dir, "artifact.json");
		await writeFile(target, "before");
		const observed = Promise.withResolvers<void>();
		const deadline = setTimeout(() => observed.reject(new Error("native watchFile adapter timed out")), 2000);
		const stop = nativeFileMonitorPoll(target, { interval: 25, persistent: false }, () => {
			if (readFileSync(target, "utf8") === "after-longer") observed.resolve();
		});

		try {
			await writeFile(target, "after-longer");
			await observed.promise;
		} finally {
			clearTimeout(deadline);
			stop();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps native watcher registration failures explicit", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-fallback-")));
		const poll = vi.fn();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: vi.fn(),
			onChange: vi.fn(),
			poll,
			watch: () => {
				throw new Error("native watcher unavailable");
			},
		});

		try {
			expect(() =>
				registry.register({
					description: "unsupported filesystem",
					path: join(dir, "artifact.json"),
					event: "create",
					timeoutMs: 5000,
				}),
			).toThrow(FileMonitorRegistrationError);
			expect(poll).not.toHaveBeenCalled();
			expect(registry.snapshot()).toEqual([]);
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("performs one final reconciliation before the deadline wins", async () => {
		vi.useFakeTimers();
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-fallback-")));
		const target = join(dir, "artifact.json");
		const emitSummary = vi.fn();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary,
			onChange: vi.fn(),
			watch: () => ({ close: vi.fn(), on: () => ({ close: vi.fn(), on: vi.fn() }) }),
		});

		try {
			registry.register({
				description: "deadline race",
				path: target,
				event: "create",
				timeoutMs: 1000,
			});
			await writeFile(target, "created before deadline");

			vi.advanceTimersByTime(1000);

			expect(emitSummary).toHaveBeenCalledWith(
				"watch_1",
				"deadline race",
				expect.stringContaining("watcher completed"),
			);
			expect(emitSummary).not.toHaveBeenCalledWith("watch_1", "deadline race", "watcher timed_out");
		} finally {
			registry.dispose();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
