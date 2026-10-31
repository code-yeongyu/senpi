// senpi#3711 regression: an idle quit took ~10 s because one session_shutdown handler (config-reload, awaiting the
// shared watch worker's terminate()) ran until the per-handler hard cap. Quit must not wait on watcher teardown, and
// the whole set of quit-time shutdown handlers shares one short total budget.
import { EventEmitter } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import configReloadExtension from "../../../src/core/extensions/builtin/config-reload/index.ts";
import { createFsWatchEventSource } from "../../../src/core/extensions/builtin/config-reload/watch-event-source.ts";
import { emitSessionShutdownEvent } from "../../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionError, SessionShutdownEvent } from "../../../src/core/extensions/types.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const never = (): Promise<void> => new Promise<void>(() => {});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

interface QuitFixture {
	readonly harness: Harness;
	readonly errors: ExtensionError[];
	readonly warnings: string[];
	readonly ran: string[];
}

async function hungThenFast(settings: Partial<Settings>): Promise<QuitFixture> {
	const ran: string[] = [];
	const harness = await createHarness({
		fileSettings: true,
		settings,
		extensionFactories: [
			{
				name: "hung-ext",
				factory: (pi: ExtensionAPI) => {
					pi.on("session_shutdown", () => {
						ran.push("hung");
						return never();
					});
				},
			},
			{
				name: "fast-ext",
				factory: (pi: ExtensionAPI) => {
					pi.on("session_shutdown", () => {
						ran.push("fast");
					});
				},
			},
		],
	});
	await harness.session.bindExtensions({ mode: "tui" });
	const errors: ExtensionError[] = [];
	harness.getExtensionRunner().onError((error) => errors.push(error));
	const warnings: string[] = [];
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	});
	return { harness, errors, warnings, ran };
}

function quitAndExit(harness: Harness): Promise<boolean> {
	return emitSessionShutdownEvent(
		harness.getExtensionRunner(),
		{ type: "session_shutdown", reason: "quit" },
		{ processExit: true },
	);
}

function track(emitted: Promise<unknown>): { settled: () => boolean } {
	let done = false;
	void emitted.then(() => {
		done = true;
	});
	return { settled: () => done };
}

describe("senpi#3711 quit does not wait out a hung shutdown handler", () => {
	it("exits within the default 2000 ms quit budget and names the handler that overran it", async () => {
		const fixture = await hungThenFast({});
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const startedAt = Date.now();
			const emission = track(quitAndExit(fixture.harness));

			await vi.advanceTimersByTimeAsync(1999);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(emission.settled()).toBe(true);

			// Measured on the host clock the runner reads: the quit waited 2000 ms, not the 10 s per-handler cap.
			expect(Date.now() - startedAt).toBe(2000);
			expect(fixture.ran).toEqual(["hung", "fast"]);
			expect(fixture.warnings).toEqual([
				"Extension <inline:hung-ext> session_shutdown handler overran the quit budget after 2000ms; quitting without it.",
			]);
			expect(fixture.errors).toEqual([]);
		} finally {
			fixture.harness.cleanup();
		}
	});

	it("honours a configured sessionShutdownQuitBudgetMs", async () => {
		const fixture = await hungThenFast({ sessionShutdownQuitBudgetMs: 250 });
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const emission = track(quitAndExit(fixture.harness));

			await vi.advanceTimersByTimeAsync(249);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(emission.settled()).toBe(true);
			expect(fixture.warnings).toEqual([
				"Extension <inline:hung-ext> session_shutdown handler overran the quit budget after 250ms; quitting without it.",
			]);
		} finally {
			fixture.harness.cleanup();
		}
	});

	it("keeps the per-handler cap when the quit budget is disabled", async () => {
		const fixture = await hungThenFast({ sessionShutdownQuitBudgetMs: 0, sessionShutdownHandlerTimeoutMs: 3000 });
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const emission = track(quitAndExit(fixture.harness));

			await vi.advanceTimersByTimeAsync(2999);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(emission.settled()).toBe(true);
			expect(fixture.errors.map((error) => error.error)).toEqual(["handler timed out after 3000ms"]);
		} finally {
			fixture.harness.cleanup();
		}
	});

	it("keeps only the per-handler cap for a quit that does not exit the process (an RPC host closing a session)", async () => {
		const fixture = await hungThenFast({ sessionShutdownHandlerTimeoutMs: 3000 });
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const emission = track(
				fixture.harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" }),
			);

			await vi.advanceTimersByTimeAsync(2999);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(emission.settled()).toBe(true);
			expect(fixture.errors.map((error) => error.error)).toEqual(["handler timed out after 3000ms"]);
			expect(fixture.warnings.some((line) => line.includes("quit budget"))).toBe(false);
		} finally {
			fixture.harness.cleanup();
		}
	});

	it("counts the quit budget from when it was armed, not from the first handler", async () => {
		const fixture = await hungThenFast({ sessionShutdownQuitBudgetMs: 1000 });
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const runner = fixture.harness.getExtensionRunner();
			runner.armProcessExitBudget();
			await vi.advanceTimersByTimeAsync(400);
			const emission = track(runner.emit({ type: "session_shutdown", reason: "quit" }));

			await vi.advanceTimersByTimeAsync(599);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(emission.settled()).toBe(true);
		} finally {
			fixture.harness.cleanup();
		}
	});

	it.each(["reload", "new"] as const)("does not apply the quit budget to %s", async (reason) => {
		const fixture = await hungThenFast({ sessionShutdownHandlerTimeoutMs: 3000 });
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const event: SessionShutdownEvent =
				reason === "new"
					? { type: "session_shutdown", reason, targetSessionFile: "/tmp/next.jsonl" }
					: { type: "session_shutdown", reason };
			const emission = track(fixture.harness.getExtensionRunner().emit(event));

			await vi.advanceTimersByTimeAsync(2500);
			expect(emission.settled()).toBe(false);
			await vi.advanceTimersByTimeAsync(500);
			expect(emission.settled()).toBe(true);
		} finally {
			fixture.harness.cleanup();
		}
	});
});

describe("senpi#3711 config-reload does not hold quit on watcher teardown", () => {
	it("finishes its quit handler while the watch disposer never settles", async () => {
		await using root = await mkdtempDisposable(join(tmpdir(), "config-quit-"));
		const cancelled: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					configReloadExtension(pi, {
						agentDir: root.path,
						subscribe: () => () => {
							cancelled.push("cancelled");
							return never();
						},
					}),
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "tui" });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			const startedAt = Date.now();
			const emission = track(harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" }));

			// No host time passes: the handler cancels its watches and returns without joining their disposal.
			await vi.advanceTimersByTimeAsync(0);
			expect(emission.settled()).toBe(true);
			expect(Date.now() - startedAt).toBe(0);
			expect(cancelled.length).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});
});

class NeverExitingWorker extends EventEmitter {
	readonly calls: string[] = [];
	postMessage(): void {}
	unref(): void {
		this.calls.push("unref");
	}
	terminate(): Promise<number> {
		this.calls.push("terminate");
		return new Promise<number>(() => {});
	}
}

describe("senpi#3711 the shared watch worker cannot keep the process alive", () => {
	it("unrefs the worker before terminating it on the last unsubscribe", () => {
		const worker = new NeverExitingWorker();
		const subscribe = createFsWatchEventSource(undefined, {
			platform: "darwin",
			createRecursiveWorker: () => worker,
		});
		const unsubscribe = subscribe("/agent/extensions", () => {});

		void unsubscribe();

		expect(worker.calls).toEqual(["unref", "terminate"]);
	});
});
