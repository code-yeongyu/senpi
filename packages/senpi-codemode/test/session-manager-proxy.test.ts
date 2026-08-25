import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../src/completion/handler.ts";
import type { CodemodeSessionManager } from "../src/extension/session-manager.ts";
import { SessionManagerProxy } from "../src/extension/session-manager-proxy.ts";
import type { EvalKernel, EvalKernelRunInput, KernelInterruptHandle } from "../src/tool/types.ts";

class FixtureError extends Error {
	readonly name = "FixtureError";
}

class FakeKernel implements EvalKernel {
	async run(input: EvalKernelRunInput): Promise<{
		readonly type: "result";
		readonly cellId: string;
		readonly ok: true;
		readonly durationMs: number;
	}> {
		return { type: "result", cellId: input.cellId, ok: true, durationMs: 0 };
	}

	async interrupt(): Promise<KernelInterruptHandle> {
		return { stateRetained: Promise.resolve(true) };
	}

	deliverToolReply(): void {}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

class FakeSessionManager implements CodemodeSessionManager {
	disposeCount = 0;
	readonly kernel = new FakeKernel();
	readonly #disposeFailure: Error | undefined;

	constructor(disposeFailure?: Error) {
		this.#disposeFailure = disposeFailure;
	}

	async getKernel(): Promise<EvalKernel> {
		return this.kernel;
	}

	async complete(): Promise<CompletionResult> {
		return { text: "ok", details: { model: "fake/model", structured: false } };
	}

	async dispose(): Promise<void> {
		this.disposeCount++;
		if (this.#disposeFailure) throw this.#disposeFailure;
	}
}

function reportingProxy(): { proxy: SessionManagerProxy; reported: unknown[] } {
	const reported: unknown[] = [];
	const proxy = new SessionManagerProxy((error) => reported.push(error));
	return { proxy, reported };
}

describe("session manager proxy teardown", () => {
	it("installs the replacement when the outgoing manager's dispose rejects", async () => {
		// Given an installed manager whose teardown will fail.
		const { proxy, reported } = reportingProxy();
		const failure = new FixtureError("kernel close failed");
		const outgoing = new FakeSessionManager(failure);
		expect(await proxy.replace(proxy.beginReplacement(), outgoing)).toBe(true);
		const next = new FakeSessionManager();

		// When a new session replaces it.
		const replaced = await proxy.replace(proxy.beginReplacement(), next);

		// Then the replacement completes and the failure is reported, not thrown.
		expect(replaced).toBe(true);
		expect(outgoing.disposeCount).toBe(1);
		expect(reported).toEqual([failure]);
		expect(await proxy.getKernel("js", () => undefined)).toBe(next.kernel);
	});

	it("resolves dispose and reports when the active manager's teardown fails", async () => {
		// Given an installed manager whose teardown will fail.
		const { proxy, reported } = reportingProxy();
		const failure = new AggregateError([new FixtureError("kernel close failed")], "Failed to dispose");
		const active = new FakeSessionManager(failure);
		expect(await proxy.replace(proxy.beginReplacement(), active)).toBe(true);

		// When the session shuts down.
		await proxy.dispose();

		// Then the lifecycle call resolves; the failure is reported and the proxy stays disposed.
		expect(active.disposeCount).toBe(1);
		expect(reported).toEqual([failure]);
		expect(() => proxy.assertEvalExecutionAllowed()).toThrow("disposed");
	});

	it("contains a superseded replacement's dispose failure", async () => {
		// Given a replacement that was superseded before installation.
		const { proxy, reported } = reportingProxy();
		const generation = proxy.beginReplacement();
		proxy.beginReplacement();
		const failure = new FixtureError("stale teardown failed");
		const stale = new FakeSessionManager(failure);

		// When the stale replacement lands.
		const replaced = await proxy.replace(generation, stale);

		// Then it is rejected quietly: disposed once, failure reported, nothing thrown.
		expect(replaced).toBe(false);
		expect(stale.disposeCount).toBe(1);
		expect(reported).toEqual([failure]);
	});
});
