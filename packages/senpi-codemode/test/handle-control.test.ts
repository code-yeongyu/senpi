import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEvalHandleHost } from "../../coding-agent/test/suite/fakes/eval-handle-host.ts";
import {
	RESERVED_HANDLE_CANCEL_TOOL,
	RESERVED_HANDLE_OUTPUT_TOOL,
	RESERVED_HANDLE_SEND_TOOL,
	RESERVED_HANDLE_STATUS_TOOL,
	RESERVED_WAIT_TOOL,
} from "../src/bridge/reserved.ts";
import { runReservedTool } from "../src/bridges/reserved-dispatch.ts";
import { handleCompletionToolCall } from "../src/completion/tool-bridge.ts";
import { HandleRegistry } from "../src/handles/handle-registry.ts";
import { Deferred, FakeKernel, fakeExtensionContext } from "./eval/fakes.ts";

const OWNER = "session-owner";

function fixture() {
	const host = new FakeEvalHandleHost({ ownerSessionId: OWNER });
	const registry = new HandleRegistry({ ownerSessionId: OWNER });
	const call = (toolName: string, args: unknown) =>
		runReservedTool(toolName, {
			callId: "call",
			args,
			executeTool: host.executeTool,
			taskToolName: "task",
			taskOutputToolName: "task_output",
			listTools: undefined,
			signal: undefined,
			emitStatus: () => {},
			marshalToolResult: () => ({ text: "", hasError: false }),
			handles: registry,
			evalHandleHost: host,
		});
	return { host, registry, call };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("handle(node).control over the host capability", () => {
	it("cancel-never-touches-successor-epoch: a task resumed between status() and cancel() is refused as stale", async () => {
		const { host, call } = fixture();
		const ref = host.spawn("agent");
		await expect(call(RESERVED_HANDLE_STATUS_TOOL, { ref })).resolves.toMatchObject({ ref, phase: "pending" });
		expect(host.openWatches).toBe(0);

		host.settle(ref.id, "first run done");
		const successor = host.resume(ref.id);

		await expect(call(RESERVED_HANDLE_CANCEL_TOOL, { ref })).rejects.toMatchObject({ code: "eval_handle_stale" });
		expect(host.epochState(ref.id, successor.run_epoch)).toMatchObject({ phase: "pending", cancelCalls: [] });
		expect(host.epochState(ref.id, 0)).toMatchObject({ phase: "succeeded", cancelCalls: [] });
		expect(host.toolCallCount("task_cancel")).toBe(0);
	});

	it("output-never-returns-successor-transcript: the same interleaving before control.output() is stale, never the successor's text", async () => {
		const { host, call } = fixture();
		const ref = host.spawn("agent");
		host.appendTranscript(ref.id, "first run line");
		await expect(call(RESERVED_HANDLE_OUTPUT_TOOL, { ref })).resolves.toMatchObject({ text: "first run line" });

		host.settle(ref.id, "done");
		const successor = host.resume(ref.id);
		host.appendTranscript(ref.id, "SUCCESSOR SECRET");

		const outcome = await call(RESERVED_HANDLE_OUTPUT_TOOL, { ref }).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		expect(outcome).toMatchObject({ error: { code: "eval_handle_stale" } });
		expect(JSON.stringify(outcome)).not.toContain("SUCCESSOR SECRET");
		await expect(
			call(RESERVED_HANDLE_OUTPUT_TOOL, { ref: successor, format: "tail", limit: 1 }),
		).resolves.toMatchObject({
			text: "SUCCESSOR SECRET",
		});
		expect(host.toolCallCount("task_output")).toBe(0);
	});

	it("send goes through the epoch-fenced host operation and refuses non-agent handles", async () => {
		const { host, call } = fixture();
		const ref = host.spawn("agent");
		await expect(call(RESERVED_HANDLE_SEND_TOOL, { ref, message: "more context" })).resolves.toMatchObject({
			ref,
			revision: 2,
		});
		expect(host.epochState(ref.id, 0).transcript).toEqual(["[user] more context"]);
		const pool = host.spawn("workpool");
		await expect(call(RESERVED_HANDLE_SEND_TOOL, { ref: pool, message: "x" })).rejects.toMatchObject({
			code: "eval_handle_operation_unsupported",
		});
		expect(host.toolCallCount("task_send")).toBe(0);
	});

	it("cancel is idempotent for its epoch and reports an already-ended run", async () => {
		const { host, call } = fixture();
		const ref = host.spawn("agent");
		await expect(call(RESERVED_HANDLE_CANCEL_TOOL, { ref })).resolves.toMatchObject({
			cancelled: true,
			phase: "cancelled",
		});
		await expect(call(RESERVED_HANDLE_CANCEL_TOOL, { ref })).resolves.toMatchObject({
			cancelled: false,
			phase: "cancelled",
		});
		await expect(call(RESERVED_WAIT_TOOL, { refs: [ref], mode: "settled" })).resolves.toEqual([
			{ status: "rejected", ref, error: { code: "eval_handle_cancelled", message: expect.any(String) } },
		]);
	});
});

function completionIdOf(reply: unknown): string {
	if (typeof reply !== "object" || reply === null || !("value" in reply)) throw new Error("missing completion reply");
	const value = reply.value;
	if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
		throw new Error("completion reply carries no id");
	}
	return value.id;
}

describe("completion(prompt, {handle: true})", () => {
	function completionCall(
		registry: HandleRegistry | undefined,
		args: unknown,
		complete: () => Promise<{ text: string; details: { model: string; structured: boolean } }>,
	) {
		const kernel = new FakeKernel([]);
		const summary = handleCompletionToolCall({
			message: { type: "tool-call", callId: "c1", toolName: "completion", args },
			kernel,
			complete,
			ctx: fakeExtensionContext(),
			isActive: () => true,
			...(registry === undefined ? {} : { handles: registry }),
			hardDeadlineMs: Date.now() + 5_000,
		});
		return { kernel, summary };
	}

	it("completion-handle-is-opt-in: plain calls still reply with text, {handle: true} replies with a control reference", async () => {
		const { registry, call } = fixture();
		const plain = completionCall(registry, { prompt: "hi", opts: {} }, async () => ({
			text: "hello",
			details: { model: "m", structured: false },
		}));
		await plain.summary;
		expect(plain.kernel.replies).toEqual([{ type: "tool-reply", callId: "c1", ok: true, value: "hello" }]);

		const settle = new Deferred<{ text: string; details: { model: string; structured: boolean } }>();
		const handled = completionCall(registry, { prompt: "hi", opts: { handle: true } }, () => settle.promise);
		await handled.summary;
		const reply = handled.kernel.replies[0];
		expect(reply).toMatchObject({
			ok: true,
			value: { kind: "completion", run_epoch: 0, handle: expect.stringMatching(/^completion:\/\/cp_/u) },
		});
		const ref = { kind: "completion", id: completionIdOf(reply), run_epoch: 0 };
		await expect(call(RESERVED_HANDLE_STATUS_TOOL, { ref })).resolves.toMatchObject({ phase: "pending" });
		settle.resolve({ text: "late answer", details: { model: "m", structured: false } });
		await expect(call(RESERVED_WAIT_TOOL, { refs: [ref] })).resolves.toEqual(["late answer"]);
	});

	it("validates before returning a handle and surfaces provider failures in the outcome", async () => {
		const { registry, call } = fixture();
		const invalid = completionCall(registry, { prompt: "   ", opts: { handle: true } }, async () => ({
			text: "x",
			details: { model: "m", structured: false },
		}));
		await invalid.summary;
		expect(invalid.kernel.replies[0]).toMatchObject({ ok: false, error: { code: "eval_handle_invalid_arguments" } });

		const failing = completionCall(registry, { prompt: "hi", opts: { handle: true } }, async () => {
			throw new Error("provider exploded");
		});
		await failing.summary;
		const ref = { kind: "completion", id: completionIdOf(failing.kernel.replies[0]), run_epoch: 0 };
		await expect(call(RESERVED_WAIT_TOOL, { refs: [ref], mode: "settled" })).resolves.toEqual([
			{ status: "rejected", ref, error: { code: "completion_failed", message: "provider exploded" } },
		]);
		const none = completionCall(undefined, { prompt: "hi", opts: { handle: true } }, async () => ({
			text: "x",
			details: { model: "m", structured: false },
		}));
		await none.summary;
		expect(none.kernel.replies[0]).toMatchObject({ ok: false, error: { code: "eval_wait_unavailable" } });
	});

	it("derives its deadline from the creating cell's hard deadline", async () => {
		vi.useFakeTimers();
		const { registry, call } = fixture();
		let aborted = false;
		const ref = registry.startCompletion({
			deadlineMs: Date.now() + 5_000,
			run: (signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted by host"));
					});
				}),
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(aborted).toBe(true);
		await expect(call(RESERVED_WAIT_TOOL, { refs: [ref], mode: "settled" })).resolves.toEqual([
			{
				status: "rejected",
				ref,
				error: { code: "completion_deadline", message: expect.stringContaining("hard deadline") },
			},
		]);
	});
});
