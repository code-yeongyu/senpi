import assert from "node:assert";
import { describe, it } from "node:test";
import { runFrameCost } from "../bench/frame-cost.ts";

function assertFrameCostShape(result: Awaited<ReturnType<typeof runFrameCost>>, expectedN: number): void {
	assert.strictEqual(result.n, expectedN);
	assert.strictEqual(result.frames, 300);
	assert.strictEqual(result.renderCalls, result.frames);
	assert.strictEqual(typeof result.p50Ms, "number");
	assert.strictEqual(typeof result.p95Ms, "number");
	assert.strictEqual(typeof result.bytesPerFrameP50, "number");
	assert.strictEqual(typeof result.initialBytes, "number");
}

describe("frame-cost bench harness", () => {
	it("returns measured frame-cost JSON when transcript has content", async () => {
		// given
		const n = 200;

		// when
		const result = await runFrameCost(n);

		// then
		assertFrameCostShape(result, n);
		assert.ok(result.p50Ms > 0, `Expected positive p50Ms, got ${result.p50Ms}`);
		assert.ok(result.bytesPerFrameP50 > 0, `Expected positive bytesPerFrameP50, got ${result.bytesPerFrameP50}`);
	});

	it("resolves without throwing when transcript is empty", async () => {
		// given
		const n = 0;

		// when
		const result = await runFrameCost(n);

		// then
		assertFrameCostShape(result, n);
	});
});
