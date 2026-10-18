import { afterEach, expect, it, vi } from "vitest";
import { getPendingQuestions } from "../../src/core/extensions/builtin/ask-user/registry.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { QuestionResponse } from "../../src/core/extensions/types.ts";
import { ConnectionQuestionBridge } from "../../src/modes/rpc/connection-question-bridge.ts";
import { closureFixture, executeQuestion } from "./ask-user-closure-support.ts";

const fixtures: Awaited<ReturnType<typeof closureFixture>>[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		for (const entry of getPendingQuestions(fixture.delivery.harness.sessionManager.getSessionId())) entry.cancel();
		fixture.delivery.harness.cleanup();
	}
	vi.useRealTimers();
});

it.each([true, false])(
	"closes timed_out once without a surface and retains timeout delivery, wait=%s",
	async (wait) => {
		const fixture = await closureFixture();
		fixtures.push(fixture);
		vi.useFakeTimers();
		const frames: object[] = [];
		const bridge = new ConnectionQuestionBridge((frame) => frames.push(frame));
		const ctx = fixture.delivery.context((request, options) => bridge.ask(request, options));
		const execution = executeQuestion(fixture, ctx, "timeout", wait);
		const completion = fixture.delivery.settled(ctx, "timeout");
		await vi.advanceTimersByTimeAsync(60_000);
		const response = await completion;
		expect(response.status).toBe("timed_out");
		expect(Reflect.get(response, "resolvedBy")).toBeUndefined();
		await execution;
		expect(fixture.closed).toEqual([{ requestId: "timeout", status: "timed_out" }]);
		expect(fixture.settled).toHaveLength(1);
		expect(fixture.delivery.deliveries).toHaveLength(wait ? 0 : 1);
		const frame = frames.at(-1);
		expect(frame).toMatchObject({ type: "question_resolved", outcome: "timed_out" });
		if (!frame) throw new Error("missing timeout frame");
		expect(Reflect.get(frame, "resolvedBy")).toBeUndefined();
	},
);

it.each([true, false])("closes cancelled once without notifying settled listeners, wait=%s", async (wait) => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const ctx = fixture.delivery.context(() => new Promise(() => {}));
	const controller = new AbortController();
	const execution = executeQuestion(fixture, ctx, "abort", wait, controller.signal);
	const entry = getPendingQuestions(ctx.sessionManager.getSessionId())[0];
	if (!entry) throw new Error("missing pending question");
	controller.abort();
	entry.cancel();
	const response = await entry.completion;
	expect(response.status).toBe("cancelled");
	expect(Reflect.get(response, "resolvedBy")).toBeUndefined();
	await execution;
	expect(fixture.closed).toEqual([{ requestId: "abort", status: "cancelled" }]);
	expect(fixture.settled).toEqual([]);
	expect(fixture.delivery.deliveries).toEqual([]);
});

it("closes unavailable once without fabricating an answering surface or a settled notification", async () => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const ctx = fixture.delivery.context(() => new Promise(() => {}));
	ctx.mode = "print";
	const result = await executeQuestion(fixture, ctx, "unavailable", true);
	expect(result.details).toMatchObject({ status: "unavailable" });
	expect(fixture.closed).toEqual([{ requestId: "unavailable", status: "unavailable" }]);
	expect(fixture.settled).toEqual([]);
	expect(fixture.delivery.deliveries).toEqual([]);
});

it("closes an orphaned question once after reload cannot restore its UI", async () => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const ctx = fixture.delivery.context(() => new Promise<QuestionResponse>(() => {}));
	fixture.runner.setUIContext(ctx.ui, "tui");
	await executeQuestion(fixture, ctx, "orphan", false);
	const completion = fixture.delivery.settled(ctx, "orphan");
	await emitSessionShutdownEvent(fixture.runner, { type: "session_shutdown", reason: "reload" });
	fixture.runner.setUIContext({ ...ctx.ui, question: undefined }, "tui");
	await fixture.runner.emit({ type: "session_start", reason: "reload" });
	const response = await completion;
	expect(response.status).toBe("orphaned-after-restart");
	expect(Reflect.get(response, "resolvedBy")).toBeUndefined();
	await fixture.runner.emit({ type: "session_start", reason: "reload" });
	expect(fixture.closed).toEqual([{ requestId: "orphan", status: "orphaned-after-restart" }]);
	expect(fixture.settled).toHaveLength(1);
	expect(fixture.delivery.deliveries).toHaveLength(1);
});

it("closes a detached non-blocking question cancelled during reload exactly once", async () => {
	const fixture = await closureFixture();
	fixtures.push(fixture);
	const ctx = fixture.delivery.context(() => new Promise(() => {}));
	fixture.runner.setUIContext(ctx.ui, "tui");
	await executeQuestion(fixture, ctx, "reload-cancel", false);
	const entry = getPendingQuestions(ctx.sessionManager.getSessionId())[0];
	if (!entry) throw new Error("missing reload question");
	await emitSessionShutdownEvent(fixture.runner, { type: "session_shutdown", reason: "reload" });
	entry.cancel();
	await entry.completion;
	await fixture.runner.emit({ type: "session_start", reason: "reload" });
	await fixture.runner.emit({ type: "session_start", reason: "reload" });
	expect(fixture.closed).toEqual([{ requestId: "reload-cancel", status: "cancelled" }]);
	expect(fixture.settled).toEqual([]);
	expect(fixture.delivery.deliveries).toEqual([]);
});
