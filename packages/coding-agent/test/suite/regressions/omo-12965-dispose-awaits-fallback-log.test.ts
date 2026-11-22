import { afterEach, describe, expect, it, vi } from "vitest";
import type * as FallbackLog from "../../../src/core/retry-fallback/log.ts";
import { createHarness, type Harness } from "../harness.ts";

// omo#12965: AgentSession builds its fallback logger at construction and the logger removes earlier log generations
// asynchronously. dispose() hands out whenToolChildClosed() as "everything this session started has finished", and
// callers remove the agent dir after awaiting it, so that promise has to cover the logger's pending removal. Otherwise
// the removal's mkdir and writeFile land after the directory is gone: they recreate agent/logs (the caller's rmdir then
// fails with ENOTEMPTY) or fail with ENOENT.

const hold = vi.hoisted(() => ({
	gate: undefined as Promise<void> | undefined,
	release: undefined as (() => void) | undefined,
}));

vi.mock("../../../src/core/retry-fallback/log.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof FallbackLog>();
	return {
		...actual,
		createFallbackLogger: (...args: Parameters<typeof actual.createFallbackLogger>) => {
			const logger = actual.createFallbackLogger(...args);
			const gate = hold.gate;
			return gate === undefined ? logger : { ...logger, settled: () => logger.settled().then(() => gate) };
		},
	};
});

describe("omo#12965 a disposed session and its fallback log", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		hold.gate = undefined;
		hold.release = undefined;
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("is not reported closed while the fallback log's first-start removal is still pending", async () => {
		hold.gate = new Promise<void>((resolve) => {
			hold.release = resolve;
		});
		const harness = await createHarness();
		harnesses.push(harness);

		harness.cleanup();
		let closed = false;
		const closing = harness.session.whenToolChildClosed().then(() => {
			closed = true;
		});
		for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));

		expect(closed).toBe(false);
		hold.release?.();
		await closing;
		expect(closed).toBe(true);
	});
});
