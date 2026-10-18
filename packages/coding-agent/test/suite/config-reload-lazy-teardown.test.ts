import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import configReloadExtension from "../../src/core/extensions/builtin/config-reload/index.ts";
import {
	ConfigReloadWatchEngine,
	type WatchEventListener,
} from "../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import { createHarness } from "./harness.ts";

afterEach(() => vi.useRealTimers());

// #1656: replaces the unsafe fire-and-forget contract with cancellation plus joined disposal.
describe("config reload shutdown", () => {
	it("cancels synchronously and joins asynchronous disposal on repeated close", async () => {
		// Given: every disposer shares an explicitly gated completion.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-close-"));
		const released = Promise.withResolvers<void>();
		const unsubscribed: string[] = [];
		const engine = new ConfigReloadWatchEngine({
			targets: ["one", "two"].map((id) => ({ id, kind: "dir", path: root.path })),
			subscribe: () => () => {
				unsubscribed.push("cancelled");
				return released.promise;
			},
			onRealChange: () => {},
		});
		let completed = false;
		try {
			// When: shutdown is requested twice before native disposal completes.
			const first = engine.close();
			const second = engine.close();
			void Promise.all([first, second]).then(() => {
				completed = true;
			});
			await Promise.resolve();
			// Then: cancellation already ran, but both callers still own the same join.
			expect(unsubscribed).toHaveLength(2);
			expect(second).toBe(first);
			expect(completed).toBe(false);
			released.resolve();
			await first;
		} finally {
			released.resolve();
			await engine.close();
		}
	});

	it("ignores stale events while asynchronous teardown is outstanding", async () => {
		// Given: a saved callback can still arrive after cancellation.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-stale-"));
		const path = join(root.path, "config.json");
		await writeFile(path, "{}");
		const released = Promise.withResolvers<void>();
		let listener: WatchEventListener = () => {};
		const changed = vi.fn();
		const engine = new ConfigReloadWatchEngine({
			targets: [{ id: "config", kind: "dir", path: root.path }],
			subscribe: (_path, callback) => {
				listener = callback;
				return () => released.promise;
			},
			onRealChange: changed,
		});
		vi.useFakeTimers();
		try {
			// When: a stale content event arrives during shutdown.
			const closing = engine.close();
			await writeFile(path, '{"changed":true}');
			listener("change", "config.json");
			await vi.runAllTimersAsync();
			// Then: inert subscriptions cannot produce reload work.
			expect(changed).not.toHaveBeenCalled();
			released.resolve();
			await closing;
		} finally {
			released.resolve();
			vi.useRealTimers();
			await engine.close();
		}
	});

	it("waits for all disposers before surfacing teardown failures", async () => {
		// Given: one failed disposer and one independently gated disposer.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-failure-"));
		const released = Promise.withResolvers<void>();
		const failure = new Error("disposer failed");
		let subscriptions = 0;
		const engine = new ConfigReloadWatchEngine({
			targets: ["one", "two"].map((id) => ({ id, kind: "dir", path: root.path })),
			subscribe: () =>
				++subscriptions === 1
					? () => {
							throw failure;
						}
					: () => released.promise,
			onRealChange: () => {},
		});
		// When: shutdown encounters the failure before the other disposer settles.
		const closing = engine.close();
		const outcome = closing.then(
			() => "resolved",
			(error: unknown) => error,
		);
		released.resolve();
		// Then: the caller receives the collected failure rather than false success.
		expect(await outcome).toMatchObject({ errors: [failure] });
	});

	it("awaits watchers before the real extension shutdown dispatch completes", async () => {
		// Given: the real extension runner with a gated event-source disposer.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-session-close-"));
		const released = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					configReloadExtension(pi, {
						agentDir: root.path,
						subscribe: () => () => {
							cancelled.resolve();
							return released.promise;
						},
					}),
			],
		});
		let completed = false;
		try {
			await harness.session.bindExtensions({ mode: "tui" });
			// When: session_shutdown traverses the real runner.
			const closing = harness
				.getExtensionRunner()
				.emit({ type: "session_shutdown", reason: "quit" })
				.then(() => {
					completed = true;
				});
			await cancelled.promise;
			await Promise.resolve();
			// Then: process teardown cannot overtake pending watcher disposal.
			expect(completed).toBe(false);
			released.resolve();
			await closing;
		} finally {
			released.resolve();
			harness.cleanup();
		}
	});

	it.each([false, true])("starts RPC watchers only for persistent sessions (persistent=%s)", async (persistent) => {
		// Given: actual in-memory or persistent session-manager ownership.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-rpc-probe-"));
		const subscribe = vi.fn(() => () => {});
		const harness = await createHarness({
			persistSession: persistent,
			extensionFactories: [
				(pi) =>
					configReloadExtension(pi, {
						agentDir: root.path,
						subscribe,
					}),
			],
		});
		try {
			// When: the RPC session binds its extensions.
			await harness.session.bindExtensions({ mode: "rpc" });
			// Then: snapshot-only probes avoid watches without disabling durable sessions.
			expect(subscribe.mock.calls.length > 0).toBe(persistent);
		} finally {
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});
});
