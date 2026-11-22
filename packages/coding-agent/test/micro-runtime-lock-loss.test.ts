import { readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonlStorage } from "../../agent/src/harness/pico3/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { MicroView } from "../src/experimental/micro/api.ts";
import { type OpenMicroResult, openMicro } from "../src/experimental/micro/runtime.ts";

// Drives openMicro's real wiring (selectSession's onLost, the gated storage, stopOnLostLock) with a
// faux model whose turn stays in flight until it is aborted, then reclaims the session lock.

vi.mock("@earendil-works/pi-agent-core/experimental/pico3", () => import("../../agent/src/harness/pico3/index.ts"));

const realLock = lockfile.lock;
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

describe("openMicro session lock loss", () => {
	it("a lost session lock aborts the running turn and no further session write lands", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const model = faux.getModel();
		let turnStarted: (signal: AbortSignal) => void = () => {};
		const started = new Promise<AbortSignal>((resolve) => {
			turnStarted = resolve;
		});
		faux.setResponses([
			(_context, options) => {
				const signal = options?.signal;
				if (!signal) throw new Error("the micro turn must carry an abort signal");
				turnStarted(signal);
				return new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve(fauxAssistantMessage([], { stopReason: "aborted" })), {
						once: true,
					}),
				);
			},
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
		const truncates = vi.spyOn(JsonlStorage.prototype, "truncate");

		const cwd = await mkdtemp(join(tmpdir(), "micro-runtime-lock-loss-"));
		cleanups.push(() => rm(cwd, { force: true, recursive: true }));
		const micro = await openMicro({ cwd });
		cleanups.push(() => micro.close());
		const sessionPath = micro.view.current().session.path;

		void micro.controller.prompt("hello");
		const turnSignal = await within(started, "the faux turn to start");
		const bytesAtLoss = sessionBytes(sessionPath);
		const commitsAtLoss = commits.mock.calls.length;
		const truncatesAtLoss = truncates.mock.calls.length;
		expect(reclaim).toBeTypeOf("function");

		reclaim?.(Object.assign(new Error("lock reclaimed by another process"), { code: "ECOMPROMISED" }));

		const stopped = await within(
			viewReaches(micro, (view) => view.fatal !== undefined),
			"micro to mark the session fatal",
		);
		expect(stopped.fatal).toMatch(/Another process took over this micro session/);
		await within(
			turnSignal.aborted
				? Promise.resolve()
				: new Promise<void>((resolve) => turnSignal.addEventListener("abort", () => resolve(), { once: true })),
			"the running turn to be aborted",
		);
		await micro.controller.prompt("after the loss");
		// The user quits: close joins every invocation and writes nothing, so all writes have settled.
		await micro.close();
		expect(commits.mock.calls.length).toBe(commitsAtLoss);
		expect(truncates.mock.calls.length).toBe(truncatesAtLoss);
		expect(sessionBytes(sessionPath)).toBe(bytesAtLoss);
	});
});
