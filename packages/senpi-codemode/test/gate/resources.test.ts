import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { setImmediate } from "node:timers/promises";
import workerThreads from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { cleanupFailures, observeResources } from "../../scripts/gate-resources.ts";

describe("owned runtime teardown observation", () => {
	it("counts another registration of a baseline callback on the same event", async () => {
		const listener = () => undefined;
		process.on("beforeExit", listener);
		const resources = observeResources();
		try {
			process.on("beforeExit", listener);
			expect((await resources.counts()).listeners).toBe(1);
		} finally {
			process.off("beforeExit", listener);
			process.off("beforeExit", listener);
			resources.restore();
		}
	});

	it("preserves subclass behavior for an observed worker", async () => {
		const resources = observeResources();
		class CustomWorker extends workerThreads.Worker {
			value() {
				return 42;
			}
		}
		const worker = new CustomWorker("", { eval: true });
		try {
			expect(worker).toBeInstanceOf(CustomWorker);
			expect(worker.value()).toBe(42);
		} finally {
			try {
				await worker.terminate();
			} finally {
				resources.restore();
			}
		}
	});

	it("waits for close after child exit instead of guessing event-loop turns", async () => {
		// Given: a child whose pipes have not closed when exit is delivered.
		const resources = observeResources();
		const child = new ChildProcess();
		globalThis.__senpiCodemodeGateObserveResource?.("processes", child, "close");
		child.emit("exit", 0, null);
		let settled = false;
		try {
			// When: inspect teardown while close is held behind an event barrier.
			const counts = resources.counts().then((value) => {
				settled = true;
				return value;
			});
			await setImmediate();
			await setImmediate();
			await setImmediate();
			// Then: exit alone cannot certify closed pipes or a resource leak.
			expect(settled).toBe(false);
			child.emit("close", 0, null);
			expect(cleanupFailures(await counts, "fixture")).toEqual([]);
		} finally {
			child.emit("close", 0, null);
			resources.restore();
		}
	});

	it("names a leaked host listener even when no worker or socket is open", async () => {
		// Given: the host process outlives every runtime resource.
		const resources = observeResources();
		const listener = () => undefined;
		process.on("beforeExit", listener);
		try {
			// When / Then
			expect(cleanupFailures(await resources.counts(), "host")).toContain("cleanup host: listeners=1");
		} finally {
			process.off("beforeExit", listener);
			resources.restore();
		}
	});
	it("names a live worker and returns to zero after its actual exit", async () => {
		// Given: constructor instrumentation in an isolated test process.
		const resources = observeResources();
		const worker = new workerThreads.Worker('require("node:worker_threads").parentPort.on("message", () => {});', {
			eval: true,
		});
		try {
			// When: measure before the worker exits.
			const live = await resources.counts();
			// Then: a close() boolean cannot hide this live worker.
			expect(cleanupFailures(live, "fixture")).toContain("cleanup fixture: workers=1");
		} finally {
			try {
				await worker.terminate();
				expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
			} finally {
				resources.restore();
			}
		}
	});

	it("names an unref'd polling interval whose setInterval was captured before observation", async () => {
		// Given: a kernel module that captured setInterval at load time, before the window opened.
		const capturedSetInterval = globalThis.setInterval;
		const resources = observeResources();
		const ticked = Promise.withResolvers<void>();
		const polling = capturedSetInterval(() => ticked.resolve(), 1).unref();
		try {
			// When: the interval has actually polled and is still alive.
			await ticked.promise;
			const live = await resources.counts();
			// Then: unref() cannot hide background polling, and the creation site is named.
			expect(cleanupFailures(live, "fixture")).toContain("cleanup fixture: timers=1");
			expect(resources.liveTimers()).toEqual([expect.stringMatching(/^setInterval at .*resources\.test\.ts:\d+/)]);
		} finally {
			try {
				clearInterval(polling);
				expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
				expect(resources.liveTimers()).toEqual([]);
			} finally {
				resources.restore();
			}
		}
	});

	it("does not count timeouts that fired or were cleared by their numeric id", async () => {
		// Given: one timeout that runs to completion and one cleared through its primitive id.
		const resources = observeResources();
		const fired = Promise.withResolvers<void>();
		setTimeout(() => fired.resolve(), 1);
		const cancelled = setTimeout(() => undefined, 60_000);
		try {
			// When
			clearTimeout(Number(cancelled));
			await fired.promise;
			// Then: only live timers are a cleanup failure.
			expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
		} finally {
			clearTimeout(cancelled);
			resources.restore();
		}
	});

	it("counts an open server and a pending subscription until both are released", async () => {
		// Given: real open handle and event-ordered pending host call.
		const resources = observeResources();
		const server = http.createServer();
		const listening = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await listening;
		const pending = Promise.withResolvers<void>();
		const subscription = resources.subscribe(pending.promise);
		try {
			// When
			const live = await resources.counts();
			// Then
			expect(cleanupFailures(live, "fixture")).toEqual(
				expect.arrayContaining(["cleanup fixture: handles=1", "cleanup fixture: subscriptions=1"]),
			);
		} finally {
			try {
				const closed = once(server, "close");
				server.close();
				await closed;
				pending.resolve();
				await subscription;
				expect(cleanupFailures(await resources.counts(), "fixture")).toEqual([]);
			} finally {
				resources.restore();
			}
		}
	});
});
