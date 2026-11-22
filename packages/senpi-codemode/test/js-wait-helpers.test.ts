import { describe, expect, it } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import type { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { parseJavaScriptResult, withJavaScriptKernel } from "./eval/js-kernel-harness.ts";

type ToolCall = Extract<KernelToHostMessage, { type: "tool-call" }>;

const agentReply = { text: "spawned", id: "st_abc123", handle: "agent://st_abc123", run_epoch: 3 };

/** Runs a cell and answers each bridge call in order with the scripted reply (a function may inspect the call). */
async function runWithReplies(
	kernel: JavaScriptKernel,
	code: string,
	replies: ReadonlyArray<unknown | ((call: ToolCall) => unknown)>,
) {
	const messages: KernelToHostMessage[] = [];
	const execution = kernel.run({
		cellId: `wait-${crypto.randomUUID()}`,
		code,
		timeoutMs: 5_000,
		onMessage: (m) => messages.push(m),
	});
	const calls: ToolCall[] = [];
	for (const reply of replies) {
		const call = await kernel.nextToolCall();
		calls.push(call);
		const value = typeof reply === "function" ? reply(call) : reply;
		kernel.deliverToolReply({ type: "tool-reply", callId: call.callId, ok: true, value });
	}
	return { result: await execution, calls, messages };
}

describe("JavaScript wait()/handle() helpers", () => {
	it("rich-handle-keeps-legacy-output: the legacy record is byte-identical and handle(node).control is non-enumerable", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const { result, calls } = await runWithReplies(
				kernel,
				`const node = await agent("solve", { handle: true });
const view = handle(node);
const snapshot = await view.control.output({ format: "tail", limit: 5 });
return {
  outputType: typeof node.output,
  nodeJson: JSON.stringify(node),
  nodeKeys: Object.keys(node),
  viewJson: JSON.stringify(view),
  viewKeys: Object.keys(view),
  controlKeys: Object.keys(view.control),
  controlEnumerable: Object.prototype.propertyIsEnumerable.call(view, "control"),
  snapshot,
};`,
				[
					agentReply,
					{
						ref: { kind: "agent", id: "st_abc123", run_epoch: 3 },
						text: "live tail",
						offset: 0,
						total: 1,
						truncated: false,
					},
				],
			);
			const value = parseJavaScriptResult(result);
			expect(value).toMatchObject({
				outputType: "string",
				nodeJson: JSON.stringify({
					text: "spawned",
					output: "spawned",
					handle: "agent://st_abc123",
					id: "st_abc123",
					run_epoch: 3,
					agent: null,
				}),
				nodeKeys: ["text", "output", "handle", "id", "run_epoch", "agent"],
				viewKeys: ["text", "output", "handle", "id", "run_epoch", "agent"],
				controlKeys: ["status", "output", "send", "cancel", "wait"],
				controlEnumerable: false,
				snapshot: { text: "live tail" },
			});
			expect(calls[1]).toMatchObject({
				toolName: "__handle_output__",
				args: { ref: { kind: "agent", id: "st_abc123", run_epoch: 3 }, format: "tail", limit: 5 },
			});
		});
	});

	it("wait() sends refs in input order with one subscription per distinct handle and rides the pause/resume path", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const { calls, messages, result } = await runWithReplies(
				kernel,
				`const a = await agent("a", { handle: true });
const b = handle({ kind: "agent", id: "st_b", run_epoch: 0 });
const pool = { pool_id: "wp_00000000000000000000000000000001" };
return await wait([a, b, pool, a], { timeout: 30, mode: "settled" });`,
				[agentReply, ["A", "B", "P", "A"]],
			);
			expect(calls[1]).toMatchObject({
				toolName: "__wait__",
				args: {
					refs: [
						{ kind: "agent", id: "st_abc123", run_epoch: 3 },
						{ kind: "agent", id: "st_b", run_epoch: 0 },
						{ kind: "workpool", id: "wp_00000000000000000000000000000001", run_epoch: 0 },
						{ kind: "agent", id: "st_abc123", run_epoch: 3 },
					],
					timeout: 30,
					mode: "settled",
				},
			});
			expect(parseJavaScriptResult(result)).toEqual(["A", "B", "P", "A"]);
			const ops = messages
				.filter((m): m is Extract<KernelToHostMessage, { type: "status" }> => m.type === "status")
				.map((m) => m.event.op);
			expect(ops.filter((op) => op === "timeout-pause")).toHaveLength(2);
			expect(ops.filter((op) => op === "timeout-resume")).toHaveLength(2);
		});
	});

	it("completion-handle-is-opt-in: completion() returns text by default and a control view with {handle: true}", async () => {
		await withJavaScriptKernel(async (kernel) => {
			const { result, calls } = await runWithReplies(
				kernel,
				`const text = await completion("hi");
const h = await completion("hi", { handle: true });
const status = await h.control.status();
return { text, handle: h.handle, keys: Object.keys(h), hasControl: typeof h.control.wait === "function", status };`,
				[
					"plain answer",
					{ kind: "completion", id: "cp_1", run_epoch: 0, handle: "completion://cp_1" },
					{
						ref: { kind: "completion", id: "cp_1", run_epoch: 0 },
						phase: "pending",
						host_status: "running",
						revision: 1,
					},
				],
			);
			expect(calls.map((call) => call.toolName)).toEqual(["completion", "completion", "__handle_status__"]);
			expect(calls[1]?.args).toEqual({ prompt: "hi", opts: { handle: true } });
			expect(parseJavaScriptResult(result)).toEqual({
				text: "plain answer",
				handle: "completion://cp_1",
				keys: ["kind", "id", "run_epoch", "handle"],
				hasControl: true,
				status: {
					ref: { kind: "completion", id: "cp_1", run_epoch: 0 },
					phase: "pending",
					host_status: "running",
					revision: 1,
				},
			});
		});
	});

	it("rejects malformed handles and options before any bridge call", async () => {
		await withJavaScriptKernel(async (kernel) => {
			for (const [code, reason] of [
				["await wait([{ id: 'st_x' }])", /handle\(\) expects/u],
				["await wait([{ kind: 'agent', id: 'st_x', run_epoch: -1 }])", /run_epoch must be a non-negative integer/u],
				["await wait([], { mode: 'sometimes' })", /mode must be/u],
				["await wait([], { timeout: Infinity })", /timeout must be a finite number/u],
				["handle('agent://st_x')", /handle\(\) expects/u],
			] as const) {
				const messages: KernelToHostMessage[] = [];
				const result = await kernel.run({
					cellId: `bad-${crypto.randomUUID()}`,
					code,
					timeoutMs: 2_000,
					onMessage: (m) => messages.push(m),
				});
				expect(result.ok, code).toBe(false);
				if (!result.ok) expect(result.error.message, code).toMatch(reason);
				expect(
					messages.some((m) => m.type === "tool-call"),
					code,
				).toBe(false);
			}
		});
	});
});
