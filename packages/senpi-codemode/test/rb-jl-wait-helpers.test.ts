import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { RESERVED_AGENT_TOOL, RESERVED_HANDLE_OUTPUT_TOOL, RESERVED_WAIT_TOOL } from "../src/bridge/reserved.ts";
import { JuliaKernel } from "../src/kernels/jl/kernel.ts";
import { RubyKernel } from "../src/kernels/rb/kernel.ts";

const agentReply = { text: "spawned", id: "st_abc123", handle: "agent://st_abc123", run_epoch: 3 };
const expectedRefs = [
	{ kind: "agent", id: "st_abc123", run_epoch: 3 },
	{ kind: "agent", id: "st_b", run_epoch: 0 },
	{ kind: "agent", id: "st_abc123", run_epoch: 3 },
];

function has(command: string): boolean {
	try {
		execFileSync(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function reply(request: BridgeHttpCallRequest): unknown {
	if (request.toolName === RESERVED_AGENT_TOOL) return agentReply;
	if (request.toolName === RESERVED_WAIT_TOOL) return ["A", "B", "A"];
	if (request.toolName === RESERVED_HANDLE_OUTPUT_TOOL) {
		return { ref: expectedRefs[0], text: "live tail", offset: 0, total: 1, truncated: false };
	}
	throw new Error(`unexpected bridge call ${request.toolName}`);
}

async function withBridge<T>(
	run: (connection: { port: number; token: string }, calls: BridgeHttpCallRequest[]) => Promise<T>,
) {
	const calls: BridgeHttpCallRequest[] = [];
	const server = await startBridgeServer({
		onCall: async (request) => {
			calls.push(request);
			return reply(request);
		},
		onEmit: async () => {},
		onCompletion: async () => "unused",
	});
	try {
		return await run({ port: server.port, token: server.token }, calls);
	} finally {
		await server.close();
	}
}

function pauseResumeCounts(messages: readonly KernelToHostMessage[]): readonly [number, number] {
	const ops = messages
		.filter((m): m is Extract<KernelToHostMessage, { type: "status" }> => m.type === "status")
		.map((m) => m.event.op);
	return [ops.filter((op) => op === "timeout-pause").length, ops.filter((op) => op === "timeout-resume").length];
}

describe.skipIf(!has("ruby"))("Ruby wait()/handle() helpers", () => {
	it("keeps the legacy record, exposes control as a singleton method, and posts wait() refs in input order", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-wait-"));
		const messages: KernelToHostMessage[] = [];
		try {
			await withBridge(async (connection, calls) => {
				const kernel = RubyKernel.start({
					cwd: root,
					sessionId: "rb-wait",
					connection,
					onMessage: (message) => messages.push(message),
				});
				try {
					const record = await kernel.run({
						cellId: "record",
						code: [
							"node = agent('solve', handle: true)",
							"view = handle(node)",
							"snapshot = view.control.output(format: 'tail', limit: 5)",
							"{ 'output_class' => node['output'].class.name, 'node_json' => JSON.generate(node), 'view_json' => JSON.generate(view), 'control_key' => view.key?('control'), 'has_control' => view.respond_to?(:control), 'snapshot_text' => snapshot['text'] }",
						].join("\n"),
						timeoutMs: 10_000,
					});
					expect(record.ok, record.ok ? "" : record.error.message).toBe(true);
					expect(JSON.parse(record.ok && record.valueRepr ? record.valueRepr : "{}")).toEqual({
						output_class: "String",
						node_json: JSON.stringify({
							text: "spawned",
							output: "spawned",
							handle: "agent://st_abc123",
							id: "st_abc123",
							run_epoch: 3,
							agent: "task",
						}),
						view_json: JSON.stringify({
							text: "spawned",
							output: "spawned",
							handle: "agent://st_abc123",
							id: "st_abc123",
							run_epoch: 3,
							agent: "task",
						}),
						control_key: false,
						has_control: true,
						snapshot_text: "live tail",
					});
					const waited = await kernel.run({
						cellId: "wait",
						code: "wait([node, handle({ 'kind' => 'agent', 'id' => 'st_b', 'run_epoch' => 0 }), node], timeout: 30, mode: 'settled')",
						timeoutMs: 10_000,
					});
					expect(waited.ok, waited.ok ? "" : waited.error.message).toBe(true);
					expect(JSON.parse(waited.ok && waited.valueRepr ? waited.valueRepr : "[]")).toEqual(["A", "B", "A"]);
					expect(calls.at(-1)).toMatchObject({
						toolName: RESERVED_WAIT_TOOL,
						args: { refs: expectedRefs, timeout: 30, mode: "settled" },
					});
					expect(pauseResumeCounts(messages)).toEqual([3, 3]);
					const bad = await kernel.run({ cellId: "bad", code: "wait([{ 'id' => 'st_x' }])", timeoutMs: 10_000 });
					expect(bad.ok).toBe(false);
					if (!bad.ok) expect(bad.error.message).toMatch(/handle\(\) expects/u);
				} finally {
					await kernel.close();
				}
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!has("julia"))("Julia wait()/handle() helpers", () => {
	it("extends Base.wait for handle views without shadowing wait(::Task), and posts refs in input order", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-jl-wait-"));
		const messages: KernelToHostMessage[] = [];
		try {
			await withBridge(async (connection, calls) => {
				const kernel = JuliaKernel.start({
					cwd: root,
					sessionId: "jl-wait",
					connection,
					onMessage: (message) => messages.push(message),
				});
				try {
					const task = await kernel.run({
						cellId: "task",
						code: 't = @async 20 + 22; wait(t); Dict("fetched" => fetch(t), "main_wait" => isdefined(Main, :wait) && which(wait, (Task,)).module === Base)',
						timeoutMs: 120_000,
					});
					expect(task.ok, task.ok ? "" : task.error.message).toBe(true);
					expect(JSON.parse(task.ok && task.valueRepr ? task.valueRepr : "{}")).toEqual({
						fetched: 42,
						main_wait: true,
					});
					const record = await kernel.run({
						cellId: "record",
						code: [
							'node = agent("solve"; handle=true)',
							"view = handle(node)",
							'snapshot = view.control.output(; format="tail", limit=5)',
							'Dict("output_type" => string(typeof(node["output"])), "node_keys" => sort(collect(keys(node))), "view_keys" => sort(collect(keys(view))), "has_control" => view.control isa SenpiHandleControl, "snapshot_text" => snapshot["text"])',
						].join("\n"),
						timeoutMs: 60_000,
					});
					expect(record.ok, record.ok ? "" : record.error.message).toBe(true);
					expect(JSON.parse(record.ok && record.valueRepr ? record.valueRepr : "{}")).toEqual({
						output_type: "String",
						node_keys: ["agent", "handle", "id", "output", "run_epoch", "text"],
						view_keys: ["agent", "handle", "id", "output", "run_epoch", "text"],
						has_control: true,
						snapshot_text: "live tail",
					});
					const waited = await kernel.run({
						cellId: "wait",
						code: 'wait([handle(node), handle(Dict("kind" => "agent", "id" => "st_b", "run_epoch" => 0)), handle(node)]; timeout=30, mode="settled")',
						timeoutMs: 60_000,
					});
					expect(waited.ok, waited.ok ? "" : waited.error.message).toBe(true);
					expect(JSON.parse(waited.ok && waited.valueRepr ? waited.valueRepr : "[]")).toEqual(["A", "B", "A"]);
					expect(calls.at(-1)).toMatchObject({
						toolName: RESERVED_WAIT_TOOL,
						args: { refs: expectedRefs, timeout: 30, mode: "settled" },
					});
					expect(pauseResumeCounts(messages)).toEqual([3, 3]);
				} finally {
					await kernel.close();
				}
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
