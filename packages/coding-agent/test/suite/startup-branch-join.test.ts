import { afterEach, describe, expect, it } from "vitest";
import { joinStartupBranches } from "../../src/core/startup-branch-join.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("joinStartupBranches", () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		unhandled.length = 0;
	});

	function captureUnhandled(): void {
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	}

	it("returns both values when both succeed", async () => {
		const runtime = deferred<string>();
		const loader = deferred<string>();
		const joined = joinStartupBranches(runtime.promise, loader.promise);
		runtime.resolve("runtime");
		loader.resolve("loader");
		await expect(joined).resolves.toEqual({ primary: "runtime", secondary: "loader" });
	});

	it("throws the model-runtime error when runtime fails and loading succeeds", async () => {
		captureUnhandled();
		const runtimeError = new Error("model-runtime");
		const runtime = deferred<string>();
		const loader = deferred<string>();
		const joined = joinStartupBranches(runtime.promise, loader.promise);
		runtime.reject(runtimeError);
		loader.resolve("loader");
		await expect(joined).rejects.toBe(runtimeError);
		await flushMicrotasks();
		expect(unhandled).toEqual([]);
	});

	it("throws the resource-loading error when loading fails and runtime succeeds", async () => {
		captureUnhandled();
		const loaderError = new Error("resource-loader");
		const runtime = deferred<string>();
		const loader = deferred<string>();
		const joined = joinStartupBranches(runtime.promise, loader.promise);
		runtime.resolve("runtime");
		loader.reject(loaderError);
		await expect(joined).rejects.toBe(loaderError);
		await flushMicrotasks();
		expect(unhandled).toEqual([]);
	});

	it("throws the model-runtime error when both fail, even if loading rejects first", async () => {
		captureUnhandled();
		const runtimeError = new Error("model-runtime");
		const loaderError = new Error("resource-loader");
		const runtime = deferred<string>();
		const loader = deferred<string>();
		const joined = joinStartupBranches(runtime.promise, loader.promise);
		loader.reject(loaderError);
		await flushMicrotasks();
		runtime.reject(runtimeError);
		await expect(joined).rejects.toBe(runtimeError);
		await flushMicrotasks();
		expect(unhandled).toEqual([]);
	});

	it("does not settle until the other branch settles after a runtime failure", async () => {
		const runtimeError = new Error("model-runtime");
		const loader = deferred<string>();
		const joined = joinStartupBranches(Promise.reject(runtimeError), loader.promise);
		let settled = false;
		void joined.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await flushMicrotasks();
		expect(settled).toBe(false);
		loader.resolve("loader");
		await expect(joined).rejects.toBe(runtimeError);
		expect(settled).toBe(true);
	});
});
