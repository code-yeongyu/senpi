import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { cleanupMrtrLifecycle, fixture } from "./fixtures/mrtr-lifecycle.ts";
import { formInput } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

afterEach(cleanupMrtrLifecycle);

const task = (status = "working", fields: Record<string, unknown> = {}) => ({
	resultType: "complete",
	taskId: "task-4195",
	status,
	createdAt: "2026-07-28T00:00:00Z",
	lastUpdatedAt: "2026-07-28T00:00:00Z",
	ttlMs: null,
	pollIntervalMs: 400_000,
	...fields,
});
const handle = () => task("working", { resultType: "task" });
const final = { content: [{ type: "text", text: "task output" }] };

describe("modern negotiated task lifecycle", () => {
	it("keeps a task pending beyond the RPC operation deadline and unwraps only its terminal result", async () => {
		const f = await fixture([handle(), task("completed", { result: final })], true);
		const working = Promise.withResolvers<void>();
		const updates: unknown[] = [];
		const pending = f.client.callTool({ name: "test" }, undefined, {
			timeout: 1000,
			maxTotalTimeout: 2000,
			onprogress: (progress) => {
				updates.push(progress);
				working.resolve();
			},
		});
		await Promise.race([working.promise, pending]);
		f.clock.advance(400_000);
		expect(await pending).toMatchObject(final);
		expect(f.transport.calls).toHaveLength(2);
		expect(f.transport.calls[1]).toMatchObject({ method: "tasks/get", params: { taskId: "task-4195" } });
		expect(f.underlying.mock.calls[1]?.[2]).toMatchObject({ timeout: 1000, maxTotalTimeout: 1000 });
		expect(f.transport.calls[0]).toHaveProperty(
			[
				"params",
				"_meta",
				"io.modelcontextprotocol/clientCapabilities",
				"extensions",
				"io.modelcontextprotocol/tasks",
			],
			{},
		);
		expect(updates[0]).toMatchObject({ message: expect.stringContaining("task-4195") });
		expect(f.clock.timers.size).toBe(0);
	});
	it.each(["abort", "cap"] as const)("sends tasks/cancel on %s and clears timers", async (reason) => {
		const f = await fixture([handle(), {}], true);
		const caller = new AbortController();
		const working = Promise.withResolvers<void>();
		const pending = f.client.callTool({ name: "test" }, undefined, {
			signal: caller.signal,
			onprogress: () => working.resolve(),
		});
		const rejected = expect(pending).rejects.toMatchObject({
			code: reason === "abort" ? "MCP_MRTR_CANCELLED" : "MCP_TASK_TIMEOUT",
		});
		await working.promise;
		if (reason === "abort") caller.abort();
		else f.clock.advance(30 * 60_000);
		await rejected;
		expect(f.transport.calls[1]).toMatchObject({ method: "tasks/cancel", params: { taskId: "task-4195" } });
		expect(f.transport.cancellations).toHaveLength(0);
		expect(f.clock.timers.size).toBe(0);
	});
	it("uses the configured cap and names both the task and setting in the error", async () => {
		vi.stubEnv("SENPI_MCP_TASK_TIMEOUT_MS", "500");
		const f = await fixture([handle(), {}], true);
		const working = Promise.withResolvers<void>();
		const pending = f.client.callTool({ name: "test" }, undefined, { onprogress: () => working.resolve() });
		const rejected = expect(pending).rejects.toThrow(/task-4195.*SENPI_MCP_TASK_TIMEOUT_MS/);
		await working.promise;
		f.clock.advance(500);
		await rejected;
		expect(f.clock.timers.size).toBe(0);
	});
	it("terminates input-required tasks without a presenter, never fabricating a decline", async () => {
		const f = await fixture(
			[
				task("input_required", { resultType: "task" }),
				task("input_required", {
					inputRequests: { question: formInput() },
				}),
				{},
			],
			true,
		);
		const working = Promise.withResolvers<void>();
		const pending = f.client.callTool({ name: "test" }, undefined, { onprogress: () => working.resolve() });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_PROCESSING_UNAVAILABLE" });
		await working.promise;
		f.clock.advance(400_000);
		await rejected;
		expect(f.transport.calls.map((call) => "method" in call && call.method)).toEqual([
			"tools/call",
			"tasks/get",
			"tasks/cancel",
		]);
		expect(JSON.stringify(f.transport.calls)).not.toContain("decline");
		expect(f.clock.timers.size).toBe(0);
	});
	it.each(["terminal", "private"] as const)(
		"answers through the %s presenter once per task input key",
		async (kind) => {
			const input = task("input_required", { inputRequests: { question: formInput() }, pollIntervalMs: 10 });
			const f = await fixture([handle(), input, {}, input, task("completed", { result: final })], true);
			const ui = mrtrTui();
			const present = vi.fn(async () => ({
				kind: "result" as const,
				result: { action: "accept" as const, content: { approved: true } },
				source: "presenter_action" as const,
				humanAdmission: true as const,
			}));
			const origin = createMcpRequestOrigin({
				...f.origin(ui.presentation),
				...(kind === "private"
					? {
							privateFormsEnforced: true,
							privateForm: { signal: new AbortController().signal, ready: () => true, present },
						}
					: {}),
			});
			const firstPoll = f.clock.nextScheduled(400_000);
			const pending = f.client.callTool(
				{ name: "test" },
				undefined,
				mcpRequestOptions(origin, {
					onprogress: () => {},
				}),
			);
			await firstPoll;
			const afterInput = f.clock.nextScheduled(10);
			f.clock.advance(400_000);
			await afterInput;
			const afterDuplicate = f.clock.nextScheduled(10);
			f.clock.advance(10);
			// The repeated key is already answered and must not cause another tasks/update.
			await afterDuplicate;
			f.clock.advance(10);
			expect(await pending).toMatchObject(final);
			const updates = f.transport.calls.filter((call) => "method" in call && call.method === "tasks/update");
			expect(updates).toHaveLength(1);
			expect(updates[0]).toHaveProperty(["params", "inputResponses", "question", "action"], "accept");
			expect(present).toHaveBeenCalledTimes(kind === "private" ? 1 : 0);
			expect(f.clock.timers.size).toBe(0);
		},
	);
	it.each(["failed", "cancelled"] as const)("surfaces terminal %s without an empty success", async (status) => {
		const f = await fixture(
			[task(status, { resultType: "task", error: { code: -32603, message: "failure" } })],
			true,
		);
		await expect(f.client.callTool({ name: "test" })).rejects.toThrow();
		expect(f.clock.timers.size).toBe(0);
	});
	it("rejects unsolicited handles without negotiating the extension", async () => {
		const f = await fixture([handle()]);
		await expect(f.client.callTool({ name: "test" })).rejects.toMatchObject({ code: "MCP_MRTR_INVALID_RESULT" });
		expect(f.transport.calls).toHaveLength(1);
	});
	it("cancels a handle even when abort races its response delivery", async () => {
		const f = await fixture([handle(), {}], true);
		const caller = new AbortController();
		const send = f.transport.send.bind(f.transport);
		vi.spyOn(f.transport, "send").mockImplementation(async (message) => {
			await send(message);
			if ("method" in message && message.method === "tools/call") caller.abort();
		});
		await expect(f.client.callTool({ name: "test" }, undefined, { signal: caller.signal })).rejects.toMatchObject({
			code: "MCP_MRTR_CANCELLED",
		});
		expect(f.transport.calls.at(-1)).toMatchObject({ method: "tasks/cancel" });
		expect(f.clock.timers.size).toBe(0);
	});
	it("losing the presenter removes elicitation from subsequent task polls", async () => {
		const f = await fixture([handle(), task("completed", { result: final })], true);
		const ui = mrtrTui();
		const scheduled = f.clock.nextScheduled(400_000);
		const pending = f.client.callTool({ name: "test" }, undefined, mcpRequestOptions(f.origin(ui.presentation)));
		await scheduled;
		ui.lose();
		f.clock.advance(400_000);
		await pending;
		const poll = f.transport.calls[1];
		expect(poll).toHaveProperty(["params", "_meta", "io.modelcontextprotocol/clientCapabilities"], {
			extensions: { "io.modelcontextprotocol/tasks": {} },
		});
	});
	it("uses bounded backoff without a hint and adopts a changed server interval", async () => {
		const f = await fixture(
			[
				task("working", { resultType: "task", pollIntervalMs: undefined }),
				task("working", { pollIntervalMs: undefined }),
				task("working", { pollIntervalMs: 7 }),
				task("completed", { result: { ...final, isError: true } }),
			],
			true,
		);
		const first = f.clock.nextScheduled(1000);
		const pending = f.client.callTool({ name: "test" });
		await first;
		const second = f.clock.nextScheduled(2000);
		f.clock.advance(1000);
		await second;
		const third = f.clock.nextScheduled(7);
		f.clock.advance(2000);
		await third;
		f.clock.advance(7);
		expect(await pending).toHaveProperty("isError", true);
		expect(f.clock.timers.size).toBe(0);
	});
	it("disconnect while waiting removes the poll and cap timers and close observer", async () => {
		const f = await fixture([handle()], true);
		const prior = f.client.onclose;
		const scheduled = f.clock.nextScheduled(400_000);
		const pending = f.client.callTool({ name: "test" });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_CONTEXT_CHANGED" });
		await scheduled;
		await f.client.close();
		await rejected;
		expect(f.clock.timers.size).toBe(0);
		expect(f.client.onclose).toBe(prior);
		expect(f.transport.calls).toHaveLength(1);
	});
	it("a stalled poll has its own request timeout and cancels the task without replaying tools/call", async () => {
		const f = await fixture([handle(), undefined, {}], true);
		const scheduled = f.clock.nextScheduled(400_000);
		const pending = f.client.callTool({ name: "test" }, undefined, { timeout: 1000 });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TRANSPORT_FAILED", retriable: false });
		await scheduled;
		const received = (f.transport.received = Promise.withResolvers<void>());
		f.clock.advance(400_000);
		await received.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await rejected;
		expect(f.transport.calls.map((call) => "method" in call && call.method)).toEqual([
			"tools/call",
			"tasks/get",
			"tasks/cancel",
		]);
		expect(f.clock.timers.size).toBe(0);
	});
	it("the cap interrupts pending task consent without leaking its timers", async () => {
		vi.stubEnv("SENPI_MCP_TASK_TIMEOUT_MS", "500000");
		const f = await fixture(
			[handle(), task("input_required", { inputRequests: { question: formInput() } }), {}],
			true,
		);
		const scheduled = f.clock.nextScheduled(400_000);
		const shown = Promise.withResolvers<void>();
		const ui = mrtrTui(async (_title, _choices, options) => {
			shown.resolve();
			return await new Promise<undefined>((resolve) => {
				options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const pending = f.client.callTool({ name: "test" }, undefined, mcpRequestOptions(f.origin(ui.presentation)));
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_TASK_TIMEOUT" });
		await scheduled;
		f.clock.advance(400_000);
		await shown.promise;
		f.clock.advance(100_000);
		await rejected;
		expect(f.transport.calls.at(-1)).toMatchObject({ method: "tasks/cancel" });
		expect(f.clock.timers.size).toBe(0);
	});
});
