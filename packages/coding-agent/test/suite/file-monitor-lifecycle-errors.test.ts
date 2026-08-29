import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileMonitorRegistry } from "../../src/core/extensions/builtin/terminal/file-monitor-registry.ts";
import { TerminalSessionBundle } from "../../src/core/extensions/builtin/terminal/session-bundle.ts";

function registration(path: string) {
	return { description: "lifecycle failure", path, event: "create" as const, timeoutMs: 5000 };
}

describe("native file monitor lifecycle errors", () => {
	afterEach(() => vi.useRealTimers());

	it.each(["event", "error", "timeout"] as const)(
		"reports asynchronous %s settlement failures without throwing through the callback",
		async (boundary) => {
			const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-lifecycle-")));
			if (boundary === "timeout") vi.useFakeTimers();
			const close = vi.fn();
			const onError = vi.fn();
			let onEvent: ((eventType: string, filename: string | null) => void) | undefined;
			let onWatcherError: ((error: Error) => void) | undefined;
			const registry = new FileMonitorRegistry({
				emitLine: vi.fn(),
				emitSummary: () => {
					throw new Error("summary failure");
				},
				onChange: vi.fn(),
				onError,
				watch: (_path, _options, listener) => {
					onEvent = listener;
					const watcher = {
						close,
						on: (_event: "error", errorListener: (error: Error) => void) => {
							onWatcherError = errorListener;
							return watcher;
						},
					};
					return watcher;
				},
			});
			registry.register(registration(join(dir, "claim.json")));

			try {
				if (boundary === "event") {
					await writeFile(join(dir, "claim.json"), "{}");
					const listener = onEvent;
					if (!listener) throw new Error("Expected native event listener");
					expect(() => listener("rename", "claim.json")).not.toThrow();
					await Promise.resolve();
				} else if (boundary === "error") {
					const listener = onWatcherError;
					if (!listener) throw new Error("Expected native error listener");
					expect(() => listener(new Error("watcher failure"))).not.toThrow();
				} else {
					expect(() => vi.advanceTimersByTime(5000)).not.toThrow();
				}
				expect(onError).toHaveBeenCalledWith(expect.any(AggregateError));
				expect(registry.snapshot()).toEqual([]);
				expect(close).toHaveBeenCalledOnce();
			} finally {
				registry.dispose();
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("reports secure settlement failures through the async boundary", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-secure-lifecycle-")));
		const target = join(dir, "claim.json");
		const reported = Promise.withResolvers<Error>();
		const registry = new FileMonitorRegistry({
			emitLine: vi.fn(),
			emitSummary: () => {
				throw new Error("summary failure");
			},
			onChange: vi.fn(),
			onError: (error) => reported.resolve(error),
		});
		const deadline = setTimeout(
			() => reported.reject(new Error("Timed out waiting for secure settlement failure")),
			5000,
		);

		try {
			await registry.register(registration(target));
			await writeFile(target, "{}");
			await expect(reported.promise).resolves.toBeInstanceOf(AggregateError);
			expect(registry.snapshot()).toEqual([]);
		} finally {
			clearTimeout(deadline);
			await registry.teardown();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("finishes bundle teardown when native watcher close throws", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "senpi-file-monitor-lifecycle-")));
		const states: string[][] = [];
		const backgrounds: string[][] = [];
		const bundle = new TerminalSessionBundle({
			fileMonitor: {
				watch: () => ({
					close: () => {
						throw new Error("close failure");
					},
					on() {
						return this;
					},
				}),
			},
		});
		const managerTeardown = vi.spyOn(bundle.manager, "teardown");
		bundle.bind({
			onMonitorEvent: vi.fn(),
			onMonitorState: (snapshot) => states.push(snapshot.map((entry) => entry.id)),
			onBackgroundState: (snapshot) => backgrounds.push(snapshot.map((entry) => entry.id)),
			onBackgroundExit: vi.fn(),
		});
		bundle.notifyBackgroundStart("bash_1", "background");
		bundle.monitors.registerFile(registration(join(dir, "claim.json")));

		try {
			await expect(bundle.teardown()).rejects.toThrow(AggregateError);
			expect(managerTeardown).toHaveBeenCalledOnce();
			expect(states.at(-1)).toEqual([]);
			expect(backgrounds.at(-1)).toEqual([]);
			bundle.notifyBackgroundStart("bash_2", "ignored after teardown");
			expect(backgrounds.at(-1)).toEqual([]);
			await expect(bundle.teardown()).resolves.toBeUndefined();
			expect(managerTeardown).toHaveBeenCalledOnce();
		} finally {
			await bundle.teardown().catch(() => undefined);
			await rm(dir, { recursive: true, force: true });
		}
	});
});
