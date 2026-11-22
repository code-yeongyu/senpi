import { describe, expect, it } from "vitest";
import type { HandleSnapshot } from "../../src/index.ts";
import { FakeEvalHandleHost } from "./fakes/eval-handle-host.ts";

const owner = { ownerSessionId: "owner" };

async function takeUpdates(updates: AsyncIterable<HandleSnapshot>, count: number): Promise<HandleSnapshot[]> {
	const taken: HandleSnapshot[] = [];
	if (count === 0) return taken;
	for await (const snapshot of updates) {
		taken.push(snapshot);
		if (taken.length === count) break;
	}
	return taken;
}

describe("FakeEvalHandleHost guarantees", () => {
	it("takes initial atomically with the subscription: a settle during setup arrives in updates exactly once", async () => {
		const host = new FakeEvalHandleHost(owner);
		const ref = host.spawn("agent");
		host.watchSetupHook = () => host.settle(ref.id, "during-setup");

		const watch = await host.watch([ref], owner);

		expect(watch.initial[0]).toMatchObject({ phase: "succeeded", revision: 2 });
		expect(await takeUpdates(watch.updates, 1)).toEqual([
			expect.objectContaining({ phase: "succeeded", revision: 2 }),
		]);
		watch.close();
		watch.close();
	});

	it("strictly increases the revision of a ref on every change", async () => {
		const host = new FakeEvalHandleHost(owner);
		const ref = host.spawn("agent");
		const watch = await host.watch([ref], owner);
		await host.send(ref, "hello", owner);
		host.settle(ref.id, "done");
		const [afterSend, afterSettle] = await takeUpdates(watch.updates, 2);
		watch.close();

		expect(watch.initial[0]?.revision).toBe(1);
		expect(afterSend?.revision).toBe(2);
		expect(afterSettle?.revision).toBe(3);
	});

	it("fences every operation by owner, id and run epoch", async () => {
		const host = new FakeEvalHandleHost(owner);
		const ref = host.spawn("agent");
		const foreign = { ownerSessionId: "someone-else" };

		await expect(host.result(ref, foreign)).rejects.toMatchObject({ code: "eval_handle_forbidden" });
		await expect(host.watch([ref], foreign)).rejects.toMatchObject({ code: "eval_handle_forbidden" });
		await expect(host.cancel({ ...ref, id: "st_missing" }, owner)).rejects.toMatchObject({
			code: "eval_handle_not_found",
		});
		await expect(host.result(ref, owner)).rejects.toMatchObject({ code: "eval_handle_pending" });

		host.settle(ref.id, "first");
		const successor = host.resume(ref.id);
		await expect(host.watch([ref], owner)).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(host.send(ref, "late", owner)).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(host.cancel(ref, owner)).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(host.output(ref, {}, owner)).rejects.toMatchObject({ code: "eval_handle_stale" });
		expect(host.epochState(ref.id, successor.run_epoch)).toMatchObject({ phase: "pending", cancelCalls: [] });
		expect(host.epochState(ref.id, 0).transcript).toEqual([]);
	});

	it("returns only the transcript of the exact epoch and never a successor's", async () => {
		const host = new FakeEvalHandleHost(owner);
		const ref = host.spawn("agent");
		host.appendTranscript(ref.id, "first run");
		host.settle(ref.id, "ok");
		const successor = host.resume(ref.id);
		host.appendTranscript(ref.id, "second run");

		const text = await host.output(successor, {}, owner);
		expect(text.text).toBe("second run");
		await expect(host.output(ref, {}, owner)).rejects.toMatchObject({ code: "eval_handle_stale" });
		expect(host.epochState(ref.id, 0).transcript).toEqual(["first run"]);
	});

	it("cancels idempotently and reports an already-ended run without touching it", async () => {
		const host = new FakeEvalHandleHost(owner);
		const ref = host.spawn("agent");
		expect(await host.cancel(ref, owner)).toMatchObject({ cancelled: true, phase: "cancelled" });
		expect(await host.cancel(ref, owner)).toMatchObject({ cancelled: false, phase: "cancelled" });
		const outcome = await host.result(ref, owner);
		expect(outcome).toMatchObject({ status: "rejected", error: { code: "eval_handle_cancelled" } });
		const done = host.spawn("agent");
		host.settle(done.id, 1);
		expect(await host.cancel(done, owner)).toMatchObject({ cancelled: false, phase: "succeeded" });
	});

	it("refuses send on non-agent kinds and models pools as open until closed", async () => {
		const host = new FakeEvalHandleHost(owner);
		const pool = host.spawn("workpool");
		await expect(host.send(pool, "x", owner)).rejects.toMatchObject({ code: "eval_handle_operation_unsupported" });
		const open = await host.watch([pool], owner);
		expect(open.initial[0]).toMatchObject({ phase: "pending", host_status: "open" });
		host.closePool(pool.id);
		host.settlePool(pool.id, {
			a: { status: "fulfilled", ref: pool, value: 1 },
			b: { status: "rejected", ref: pool, error: { code: "boom", message: "b failed" } },
		});
		const [closed, settled] = await takeUpdates(open.updates, 2);
		open.close();
		expect(closed).toMatchObject({ phase: "pending", host_status: "closed" });
		expect(settled).toMatchObject({ phase: "failed" });
		await expect(host.result(pool, owner)).resolves.toMatchObject({
			status: "rejected",
			error: { code: "eval_workpool_failed" },
		});
	});

	it("answers as the task tool and records every tool call", async () => {
		const host = new FakeEvalHandleHost(owner);
		const spawned = await host.executeTool("task", { prompt: "p", run_in_background: true });
		expect(spawned.details).toMatchObject({ task_id: expect.stringMatching(/^st_[0-9a-f]+$/u), run_epoch: 0 });
		await host.executeTool("task_output", { ids: ["x"] });
		expect(host.toolCallCount("task")).toBe(1);
		expect(host.toolCallCount("task_output")).toBe(1);
		await expect(host.executeTool("nope", {})).rejects.toMatchObject({ code: "unknown_tool" });
	});
});
