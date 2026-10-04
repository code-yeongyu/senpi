import type { HandleRef } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEvalHandleHost } from "../../coding-agent/test/suite/fakes/eval-handle-host.ts";
import { RESERVED_WAIT_TOOL } from "../src/bridge/reserved.ts";
import { runReservedTool } from "../src/bridges/reserved-dispatch.ts";
import { HandleRegistry } from "../src/handles/handle-registry.ts";
import { waitForHandles } from "../src/handles/wait.ts";
import { Deferred } from "./eval/fakes.ts";

const OWNER = "session-owner";

function fixture(options: { host?: boolean } = {}) {
	const host = new FakeEvalHandleHost({ ownerSessionId: OWNER });
	const registry = new HandleRegistry({ ownerSessionId: OWNER });
	const call = (toolName: string, args: unknown, signal?: AbortSignal) =>
		runReservedTool(toolName, {
			callId: "call",
			args,
			executeTool: host.executeTool,
			taskToolName: "task",
			taskOutputToolName: "task_output",
			listTools: undefined,
			signal,
			emitStatus: () => {},
			marshalToolResult: () => ({ text: "", hasError: false }),
			handles: registry,
			...(options.host === false ? {} : { evalHandleHost: host }),
		});
	const wait = (refs: readonly HandleRef[], extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
		call(RESERVED_WAIT_TOOL, { refs, ...extra }, signal);
	return { host, registry, call, wait };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("wait() barrier over the handle registry", () => {
	it("wait-preserves-order: all returns values in input order even when B settles first", async () => {
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const b = host.spawn("agent");
		const pending = wait([a, b]);
		host.settle(b.id, "B");
		host.settle(a.id, "A");
		await expect(pending).resolves.toEqual(["A", "B"]);
		expect(host.openWatches).toBe(0);
	});

	it("wait-atomic-subscribe-and-epoch-fence: a settle during watch() setup is seen once and a successor epoch is never followed", async () => {
		const { host, wait, call } = fixture();
		const a = host.spawn("agent");
		const b = host.spawn("agent");
		// A settles while watch() is still assembling `initial`: it shows up terminal there AND once in updates.
		host.watchSetupHook = () => host.settle(a.id, "early");
		const pending = wait([a, b]);
		await vi.waitFor(() => expect(host.calls.filter((entry) => entry.op === "watch")).toHaveLength(1));
		host.settle(b.id, "later");
		await expect(pending).resolves.toEqual(["early", "later"]);
		const fetched = host.calls.filter((entry) => entry.op === "result").map((entry) => entry.refs[0]?.id);
		expect(fetched).toEqual([a.id, b.id]);

		const successor = host.resume(a.id);
		await expect(wait([a])).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(call("__handle_status__", { ref: a })).rejects.toMatchObject({ code: "eval_handle_stale" });
		expect(host.epochState(a.id, successor.run_epoch)).toMatchObject({ phase: "pending", cancelCalls: [] });
	});

	it("wait-any-settled-empty-and-timeout", async () => {
		vi.useFakeTimers();
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const b = host.spawn("agent");
		const any = wait([a, b], { mode: "any" });
		host.fail(a.id, { code: "boom", message: "a failed" });
		host.settle(b.id, "B");
		await expect(any).resolves.toEqual({ index: 1, ref: b, value: "B" });

		await expect(wait([a, b, a], { mode: "settled" })).resolves.toEqual([
			{ status: "rejected", ref: a, error: { code: "boom", message: "a failed" } },
			{ status: "fulfilled", ref: b, value: "B" },
			{ status: "rejected", ref: a, error: { code: "boom", message: "a failed" } },
		]);
		expect(host.calls.filter((entry) => entry.op === "watch").at(-1)?.refs).toEqual([a, b]);

		await expect(wait([])).resolves.toEqual([]);
		await expect(wait([], { mode: "settled" })).resolves.toEqual([]);
		await expect(wait([], { mode: "any" })).rejects.toMatchObject({ code: "eval_wait_empty" });

		const slow = host.spawn("agent");
		const timed = wait([slow, b], { timeout: 1 });
		timed.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(999);
		expect(host.openWatches).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(timed).rejects.toThrow(
			"eval_wait_timeout: wait() timed out after 1s; 1/2 handles settled; work was not cancelled",
		);
		expect(host.openWatches).toBe(0);
		expect(host.epochState(slow.id, 0)).toMatchObject({ phase: "pending", cancelCalls: [] });
		await expect(wait([slow], { timeout: 0 })).rejects.toMatchObject({ code: "eval_wait_timeout" });
	});

	it("all raises the first failed handle's error without waiting for the rest; any aggregates when none succeed", async () => {
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const b = host.spawn("agent");
		const all = wait([a, b]);
		host.lose(b.id);
		await expect(all).rejects.toMatchObject({ code: "eval_handle_lost" });
		expect(host.openWatches).toBe(0);
		host.fail(a.id, { code: "boom", message: "a failed" });
		await expect(wait([a, b], { mode: "any" })).rejects.toMatchObject({ code: "eval_wait_all_rejected" });
	});

	it("needs a closed workpool and surfaces the keyed aggregate when a key fails", async () => {
		const { host, wait } = fixture();
		const pool = host.spawn("workpool");
		await expect(wait([pool])).rejects.toMatchObject({ code: "eval_pool_open" });
		host.closePool(pool.id);
		const pending = wait([pool]);
		host.settlePool(pool.id, {
			one: { status: "fulfilled", ref: pool, value: 1 },
			two: { status: "rejected", ref: pool, error: { code: "boom", message: "two failed" } },
		});
		await expect(pending).rejects.toMatchObject({
			code: "eval_workpool_failed",
			details: { keys: expect.any(Object) },
		});
	});

	it("Given a timeout longer than the platform timer limit, when time passes, then wait() keeps waiting past one timer span and still returns the settled value", async () => {
		vi.useFakeTimers();
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const pending = wait([a], { timeout: 2_200_000 });
		pending.catch(() => undefined);

		await vi.advanceTimersByTimeAsync(2 ** 31 + 10);
		expect(host.openWatches).toBe(1);
		host.settle(a.id, "A");

		await expect(pending).resolves.toEqual(["A"]);
	});

	it("Given a timeout longer than the platform timer limit that runs out, then wait() times out at the full deadline, not one timer span early", async () => {
		vi.useFakeTimers();
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const pending = wait([a], { timeout: 2_200_000 });
		pending.catch(() => undefined);

		await vi.advanceTimersByTimeAsync(2_200_000_000 - 1);
		expect(host.openWatches).toBe(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(pending).rejects.toThrow("wait() timed out after 2200000s");
		expect(host.openWatches).toBe(0);
	});

	it("Given a runtime without the host capability, when one wait mixes a completion handle with an agent ref, then it fails as unavailable and leaves no completion subscription behind", async () => {
		const { host, registry, wait } = fixture({ host: false });
		const completion = registry.startCompletion({
			run: () => new Promise(() => {}),
			deadlineMs: Date.now() + 60_000,
		});
		const a = host.spawn("agent");

		await expect(wait([completion, a])).rejects.toMatchObject({ code: "eval_wait_unavailable" });

		expect(registry.openCompletionWatches).toBe(0);
	});

	it("wait-unavailable-host: without ctx.evalHandleHost an agent ref fails with eval_wait_unavailable and no task_output call", async () => {
		const { host, wait } = fixture({ host: false });
		const a = host.spawn("agent");
		await expect(wait([a])).rejects.toMatchObject({ code: "eval_wait_unavailable" });
		await expect(wait([a])).rejects.toThrow(/not supported by this runtime/u);
		expect(host.toolCallCount("task_output")).toBe(0);
		expect(host.calls).toEqual([]);
	});

	it("wait-completion-handle-without-host-capability: a completion handle waits fine on plain senpi", async () => {
		const { registry, wait, call } = fixture({ host: false });
		const settle = new Deferred<unknown>();
		const ref = registry.startCompletion({ run: () => settle.promise, deadlineMs: Number.POSITIVE_INFINITY });
		const pending = wait([ref], { timeout: 60 });
		settle.resolve("done");
		await expect(pending).resolves.toEqual(["done"]);
		await expect(call("__handle_status__", { ref })).resolves.toMatchObject({ phase: "succeeded" });
		await expect(call("__handle_output__", { ref })).resolves.toMatchObject({ text: "done" });
		await expect(call("__handle_send__", { ref, message: "x" })).rejects.toMatchObject({
			code: "eval_handle_operation_unsupported",
		});
	});

	it("fails every ref closed with eval_handle_stale once the session generation is dropped", async () => {
		const { host, registry, wait, call } = fixture();
		const a = host.spawn("agent");
		const completion = registry.startCompletion({
			run: () => new Promise(() => {}),
			deadlineMs: Date.now() + 60_000,
		});
		const parked = wait([a, completion]);
		parked.catch(() => undefined);
		registry.dispose();
		await expect(parked).rejects.toThrow();
		expect(host.openWatches).toBe(0);
		await expect(wait([a])).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(wait([completion])).rejects.toMatchObject({ code: "eval_handle_stale" });
		await expect(call("__handle_cancel__", { ref: a })).rejects.toMatchObject({ code: "eval_handle_stale" });
		expect(host.epochState(a.id, 0).cancelCalls).toEqual([]);
	});

	it("closes its subscription immediately when the cell signal aborts and never cancels the work", async () => {
		const { host, wait } = fixture();
		const a = host.spawn("agent");
		const controller = new AbortController();
		const parked = wait([a], {}, controller.signal);
		parked.catch(() => undefined);
		controller.abort(new Error("cell cancelled"));
		await expect(parked).rejects.toThrow("cell cancelled");
		expect(host.openWatches).toBe(0);
		expect(host.epochState(a.id, 0)).toMatchObject({ phase: "pending", cancelCalls: [] });
	});

	it("rejects a foreign owner's handle and malformed refs before reaching the host", async () => {
		const { host, wait } = fixture();
		const foreign = host.spawn("agent", { ownerSessionId: "another-session" });
		await expect(wait([foreign])).rejects.toMatchObject({ code: "eval_handle_forbidden" });
		await expect(wait([{ kind: "agent", id: "", run_epoch: 0 }])).rejects.toMatchObject({
			code: "eval_handle_invalid_arguments",
		});
		await expect(wait([foreign], { timeout: -1 })).rejects.toMatchObject({ code: "eval_handle_invalid_arguments" });
	});

	it("times out from entry even when the host is still subscribing, and closes the late subscription", async () => {
		vi.useFakeTimers();
		const subscribing = Promise.withResolvers<import("@code-yeongyu/senpi").HandleWatch>();
		const closed = vi.fn();
		const pending = waitForHandles(
			{ refs: [{ kind: "agent", id: "slow", run_epoch: 1 }], mode: "all", timeoutSeconds: 2 },
			{ watch: () => subscribing.promise, result: () => new Promise(() => {}) },
		);
		const settled = expect(pending).rejects.toMatchObject({ code: "eval_wait_timeout" });

		await vi.advanceTimersByTimeAsync(2_000);
		await settled;
		subscribing.resolve({
			initial: [],
			updates: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
			close: closed,
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("ends with its cell when the cell is cancelled while a settled handle's result is still being fetched", async () => {
		const controller = new AbortController();
		const ref = { kind: "agent" as const, id: "done", run_epoch: 1 };
		const closed = vi.fn();
		const pending = waitForHandles(
			{ refs: [ref], mode: "all" },
			{
				watch: async () => ({
					initial: [{ ref, phase: "succeeded", host_status: "done", revision: 1 }],
					updates: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) },
					close: closed,
				}),
				result: () => new Promise(() => {}),
				signal: controller.signal,
			},
		);
		await vi.waitFor(() => expect(closed).not.toHaveBeenCalled());

		controller.abort(new Error("cell cancelled"));

		await expect(pending).rejects.toThrow("cell cancelled");
		expect(closed).toHaveBeenCalledTimes(1);
	});
});
