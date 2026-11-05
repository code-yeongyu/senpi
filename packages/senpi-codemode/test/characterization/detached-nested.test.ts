import type { AgentToolResult, ExtensionToolContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RESERVED_AGENT_TOOL } from "../../src/bridge/reserved.ts";
import { EvalDetachedCellManager, type EvalDetachedCellNotification } from "../../src/tool/detached-cell-manager.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "../eval/fakes.ts";
import { createCompletionFixture, createTaskFixture } from "../fixtures/task-fixture/task-fixture.ts";

// G4 characterization: today's detached nested completion() and agent(). A cell detaches past its foreground
// window, then calls back into the host. These tests pin what happens to those nested calls; they change no code.

type ToolReply = { readonly type: "tool-reply"; readonly callId: string };

class ReplyKernel extends FakeKernel {
	readonly #waiters = new Map<string, (reply: unknown) => void>();

	override deliverToolReply(message: unknown): void {
		super.deliverToolReply(message);
		if (typeof message !== "object" || message === null || !("callId" in message)) return;
		const callId = String(message.callId);
		this.#waiters.get(callId)?.(message);
		this.#waiters.delete(callId);
	}

	toolCall(callId: string, toolName: string, args: unknown): Promise<unknown> {
		const reply = new Promise<unknown>((resolve) => this.#waiters.set(callId, resolve));
		this.emit({ type: "tool-call", callId, toolName, args });
		return reply;
	}

	repliesFor(callId: string): ToolReply[] {
		return this.replies.filter(
			(reply): reply is ToolReply =>
				typeof reply === "object" && reply !== null && "callId" in reply && reply.callId === callId,
		);
	}
}

function textOf(value: AgentToolResult<unknown>): string {
	const texts: string[] = [];
	for (const part of value.content) if (part.type === "text") texts.push(part.text);
	return texts.join("\n");
}

afterEach(() => {
	vi.useRealTimers();
});

async function detachedCell(cellId: string) {
	vi.useFakeTimers();
	const notices: EvalDetachedCellNotification[] = [];
	const manager = new EvalDetachedCellManager({ notifier: { notify: (cells) => notices.push(...cells) } });
	const kernel = new ReplyKernel([]);
	const tasks = createTaskFixture();
	const completions = createCompletionFixture();
	const tool = createEvalTool({
		enabledLanguages: { js: true, py: false, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 1,
		executeTool: tasks.executeTool,
		complete: completions.complete,
		cellManager: manager,
	});
	const ctx: ExtensionToolContext = { ...fakeExtensionContext(), mode: "tui" };
	const caller = new AbortController();
	const started = kernel.deferNextRun();
	const execution = tool.execute(
		cellId,
		{ language: "js", code: "await nested()", summary: "nested calls", on_timeout: "detach" },
		caller.signal,
		undefined,
		ctx,
	);
	await started;
	await vi.advanceTimersByTimeAsync(1_000);
	const returned = await execution;
	return { manager, kernel, tasks, completions, ctx, caller, notices, returned };
}

describe("G4 characterization: detached nested completion() and agent()", () => {
	it("dispatches completion() and agent() after eval returned, on the submitting call's context", async () => {
		const cell = await detachedCell("g4-nested");
		expect(textOf(cell.returned)).toContain("g4-nested");
		expect(cell.manager.peek("g4-nested").state).toBe("detached");
		expect(cell.tasks.calls).toEqual([]);
		expect(cell.completions.calls).toEqual([]);

		const completionReply = await cell.kernel.toolCall("c-1", "completion", { prompt: "summarize" });
		const agentReply = await cell.kernel.toolCall("a-1", RESERVED_AGENT_TOOL, {
			prompt: "review",
			agent: "reviewer",
		});
		const handleReply = await cell.kernel.toolCall("a-2", RESERVED_AGENT_TOOL, {
			prompt: "background",
			handle: true,
		});

		expect(completionReply).toEqual({ type: "tool-reply", callId: "c-1", ok: true, value: "COMPLETION:summarize" });
		expect(cell.completions.calls).toHaveLength(1);
		expect(cell.completions.calls[0]?.request).toMatchObject({ prompt: "summarize" });
		const nestedCtx = cell.completions.calls[0]?.ctx;
		expect(nestedCtx).not.toBe(cell.ctx);
		expect(nestedCtx).toEqual({ ...cell.ctx, signal: expect.any(AbortSignal) });
		expect(nestedCtx?.signal?.aborted).toBe(false);
		expect(agentReply).toEqual({
			type: "tool-reply",
			callId: "a-1",
			ok: true,
			value: { text: "TASK_RESULT:review" },
		});
		expect(handleReply).toEqual({
			type: "tool-reply",
			callId: "a-2",
			ok: true,
			value: { text: "Started st_0002", id: "st_0002", handle: "agent://st_0002", run_epoch: 0 },
		});
		expect(cell.tasks.calls.map(({ toolName, params }) => ({ toolName, params }))).toEqual([
			{ toolName: "task", params: { prompt: "review", subagent_type: "reviewer", run_in_background: false } },
			{ toolName: "task", params: { prompt: "background", run_in_background: true } },
		]);
		expect(cell.manager.peek("g4-nested").state).toBe("detached");

		cell.kernel.completeDeferredRun(result("g4-nested", "'nested done'"));
		await cell.manager.waitForTerminal("g4-nested");
		await cell.manager.flushNotifications();
		expect(cell.manager.peek("g4-nested").state).toBe("completed");
		expect(cell.manager.peek("g4-nested").result.details.toolCalls).toEqual([
			expect.objectContaining({ name: "completion", ok: true, callId: "c-1" }),
			expect.objectContaining({ name: RESERVED_AGENT_TOOL, ok: true, callId: "a-1" }),
			expect.objectContaining({ name: RESERVED_AGENT_TOOL, ok: true, callId: "a-2" }),
		]);
		expect(cell.notices).toHaveLength(1);
		expect(cell.notices[0]?.cellId).toBe("g4-nested");
		expect(cell.notices[0]?.content).toContain("nested done");
	});

	it("fails the detached cell and aborts its nested agent() when the submitting call's signal aborts after detach", async () => {
		const cell = await detachedCell("g4-caller-abort");
		const held = cell.tasks.holdNext();
		void cell.kernel.toolCall("a-1", RESERVED_AGENT_TOOL, { prompt: "slow" });
		const call = await held.entered;

		cell.caller.abort(new Error("turn aborted"));
		await held.settled;
		const terminal = await cell.manager.waitForTerminal("g4-caller-abort");
		await cell.manager.flushNotifications();

		expect(call.signal?.aborted).toBe(true);
		expect(String(call.signal?.reason)).toBe("Error: turn aborted");
		expect(terminal.state).toBe("failed");
		expect(cell.kernel.interrupts).toEqual(["turn aborted"]);
		expect(cell.kernel.repliesFor("a-1")).toEqual([]);
		expect(cell.notices).toHaveLength(1);
		expect(cell.notices[0]?.content).toContain("Detached eval cell g4-caller-abort (js) failed.\nturn aborted");
	});

	it("aborts an in-flight nested agent() when the detached cell is stopped, and delivers no reply for it", async () => {
		const cell = await detachedCell("g4-stop");
		const held = cell.tasks.holdNext();
		void cell.kernel.toolCall("a-1", RESERVED_AGENT_TOOL, { prompt: "slow" });
		const call = await held.entered;
		expect(call.signal?.aborted).toBe(false);

		const stopped = await cell.manager.stop("g4-stop");
		await held.settled;
		await cell.manager.flushNotifications();

		expect(stopped.state).toBe("cancelled");
		expect(call.signal?.aborted).toBe(true);
		expect(cell.kernel.repliesFor("a-1")).toEqual([]);
		expect(cell.notices.map((notice) => notice.cellId)).toEqual(["g4-stop"]);
	});

	it("drops a nested call the kernel sends after the detached cell completed", async () => {
		const cell = await detachedCell("g4-late");
		cell.kernel.completeDeferredRun(result("g4-late", "1"));
		await cell.manager.waitForTerminal("g4-late");
		await cell.manager.flushNotifications();

		cell.kernel.emit({ type: "tool-call", callId: "late", toolName: RESERVED_AGENT_TOOL, args: { prompt: "late" } });
		cell.kernel.emit({ type: "tool-call", callId: "late-c", toolName: "completion", args: { prompt: "late" } });
		await vi.advanceTimersByTimeAsync(0);

		expect(cell.tasks.calls).toEqual([]);
		expect(cell.completions.calls).toEqual([]);
		expect(cell.kernel.repliesFor("late")).toEqual([]);
		expect(cell.kernel.repliesFor("late-c")).toEqual([]);
		expect(cell.notices).toHaveLength(1);
	});
});
