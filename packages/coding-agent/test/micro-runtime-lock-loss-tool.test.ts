import { readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Harness, JsonlStorage, kinds } from "../../agent/src/harness/pico3/index.ts";
import { ViewManager } from "../../agent/src/harness/pico3/view.ts";
import { appendDebugLogEntry } from "../src/core/hidden-stdout-log.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { MicroView } from "../src/experimental/micro/api.ts";
import { type OpenMicroResult, openMicro } from "../src/experimental/micro/runtime.ts";

vi.mock("@earendil-works/pi-agent-core/experimental/pico3", () => import("../../agent/src/harness/pico3/index.ts"));
vi.mock("../src/core/hidden-stdout-log.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/hidden-stdout-log.ts")>()),
	appendDebugLogEntry: vi.fn(),
}));

const realLock = lockfile.lock;
const realStorageClose = JsonlStorage.prototype.close;
const realHarnessOpen = Harness.open.bind(Harness);
const realViewsClose = ViewManager.prototype.close;
const realCreate = ModelRuntime.create.bind(ModelRuntime);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function sessionBytes(path: string): number {
	return readdirSync(path).reduce((total, file) => total + statSync(join(path, file)).size, 0);
}

function within<T>(promise: Promise<T>, what: string, ms = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function viewReaches(micro: OpenMicroResult, predicate: (view: MicroView) => boolean): Promise<MicroView> {
	return new Promise((resolve) => {
		const check = () => {
			const view = micro.view.current();
			if (!predicate(view)) return;
			unsubscribe();
			resolve(view);
		};
		const unsubscribe = micro.view.subscribe(check);
		check();
	});
}

describe("openMicro session lock loss during a tool call", () => {
	it("closes the session files without writing when the lock is lost while a tool waits", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
		]);
		vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
			const runtime = await realCreate(options);
			vi.spyOn(runtime, "getModel").mockReturnValue(model);
			vi.spyOn(runtime, "streamSimple").mockImplementation((m, context, streamOptions) =>
				streamSimple(m, context, streamOptions),
			);
			return runtime;
		});
		let reclaim: ((error: Error) => void) | undefined;
		vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
			if (file.includes("micro-sessions")) reclaim = options?.onCompromised;
			return realLock(file, options);
		});
		const commits = vi.spyOn(JsonlStorage.prototype, "commit");
		let viewsClosedSignal: () => void = () => {};
		const viewsClosedAll = new Promise<void>((resolve) => {
			viewsClosedSignal = resolve;
		});
		const viewsClosed = vi.spyOn(ViewManager.prototype, "close").mockImplementation(function (this: ViewManager) {
			viewsClosedSignal();
			return realViewsClose.call(this);
		});
		let stopLoggedSignal: () => void = () => {};
		const stopLogged = new Promise<void>((resolve) => {
			stopLoggedSignal = resolve;
		});
		vi.mocked(appendDebugLogEntry).mockImplementation((header) => {
			if (header.startsWith("micro session stop")) stopLoggedSignal();
		});
		let storageClosed: () => void = () => {};
		const closed = new Promise<void>((resolve) => {
			storageClosed = resolve;
		});
		const closes = vi.spyOn(JsonlStorage.prototype, "close").mockImplementation(async function (
			this: JsonlStorage,
			...args
		) {
			storageClosed();
			return realStorageClose.apply(this, args);
		});
		let toolWaiting: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			toolWaiting = resolve;
		});
		// A beforeTool hook that waits (as a permission prompt does) leaves the tool slot's waitingOn set,
		// so suspend has a real write to attempt after the loss.
		vi.spyOn(Harness, "open").mockImplementation(async (...args: Parameters<typeof Harness.open>) => {
			const harness = await realHarnessOpen(...args);
			harness.hooks(harness.namespace("test.lock-loss-wait", {}), kinds.tool, {
				beforeTool: async (_call, api, ctx) => {
					await api.waiting(ctx);
					toolWaiting();
					await new Promise<void>((resolve) => {
						if (ctx.abortSignal?.aborted) return resolve();
						ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
					});
				},
			});
			return harness;
		});

		const cwd = await mkdtemp(join(tmpdir(), "micro-lock-loss-tool-"));
		cleanups.push(() => rm(cwd, { force: true, recursive: true }));
		const micro = await openMicro({ cwd });
		cleanups.push(() => micro.close());
		const sessionPath = micro.view.current().session.path;

		void micro.controller.prompt("run the tool");
		await within(started, "the tool call to wait in its beforeTool hook");
		const bytesAtLoss = sessionBytes(sessionPath);
		expect(closes).not.toHaveBeenCalled();
		expect(viewsClosed).not.toHaveBeenCalled();

		reclaim?.(Object.assign(new Error("lock reclaimed by another process"), { code: "ECOMPROMISED" }));

		await within(
			viewReaches(micro, (view) => view.fatal !== undefined),
			"micro to mark the session fatal",
		);
		await within(closed, "the stop path to close the session files without micro.close()");
		await within(viewsClosedAll, "the stop path to close the views without micro.close()");
		await within(stopLogged, "the refused stop to be logged");
		const logged = vi.mocked(appendDebugLogEntry);
		expect(viewsClosed).toHaveBeenCalled();
		const [, detail] = logged.mock.calls.find(([header]) => header.startsWith("micro session stop")) ?? [];
		expect(JSON.parse(detail ?? "{}")).toMatchObject({ event: "micro_lost_lock_stop_failed" });
		expect(detail).not.toContain(sessionPath);
		await Promise.allSettled(commits.mock.results.map((result) => result.value));
		expect(sessionBytes(sessionPath)).toBe(bytesAtLoss);
	});
});
