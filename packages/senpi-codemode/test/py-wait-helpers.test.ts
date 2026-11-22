import { describe, expect, it } from "vitest";
import { type BridgeHttpCallRequest, startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { RESERVED_AGENT_TOOL, RESERVED_HANDLE_OUTPUT_TOOL, RESERVED_WAIT_TOOL } from "../src/bridge/reserved.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { PythonKernel } from "../src/kernels/py/kernel.ts";
import { hasPython3, runCell } from "./py-kernel/fixtures.ts";

const agentReply = { text: "spawned", id: "st_abc123", handle: "agent://st_abc123", run_epoch: 3 };

async function withPythonBridge<T>(
	onCall: (request: BridgeHttpCallRequest) => unknown,
	run: (kernel: PythonKernel, calls: BridgeHttpCallRequest[], messages: KernelToHostMessage[]) => Promise<T>,
	options: { readonly onCompletion?: (request: { prompt: string; opts?: unknown }) => unknown } = {},
): Promise<T> {
	const detected = await createInterpreterDetector().detect("py");
	if (!detected.ok) throw new Error("python unavailable");
	const calls: BridgeHttpCallRequest[] = [];
	const messages: KernelToHostMessage[] = [];
	const server = await startBridgeServer({
		onCall: async (request) => {
			calls.push(request);
			return onCall(request);
		},
		onEmit: async () => {},
		onCompletion: async (request) => options.onCompletion?.(request) ?? "plain answer",
	});
	const kernel = await PythonKernel.start({
		interpreterPath: detected.path,
		sessionId: `py-wait-${crypto.randomUUID()}`,
		cwd: process.cwd(),
		connection: { port: server.port, token: server.token },
		onMessage: (message) => messages.push(message),
	});
	try {
		return await run(kernel, calls, messages);
	} finally {
		await kernel.close();
		await server.close();
	}
}

function stdoutJson(messages: readonly KernelToHostMessage[]): unknown {
	const text = messages
		.filter((m): m is Extract<KernelToHostMessage, { type: "text" }> => m.type === "text" && m.stream === "stdout")
		.map((m) => m.data)
		.join("");
	const parsed: unknown = JSON.parse(text.trim());
	return parsed;
}

describe.skipIf(!(await hasPython3()))("Python wait()/handle() helpers", () => {
	it("rich-handle-keeps-legacy-output: the record stays a plain dict and handle(node) is a dict subclass with a control attribute", async () => {
		await withPythonBridge(
			(request) =>
				request.toolName === RESERVED_AGENT_TOOL
					? agentReply
					: { ref: request.args, text: "live tail", offset: 0, total: 1, truncated: false },
			async (kernel, calls, messages) => {
				const result = await runCell(
					kernel,
					[
						"import json",
						"node = agent('solve', handle=True)",
						"view = handle(node)",
						"snapshot = view.control.output(format='tail', limit=5)",
						"print(json.dumps({",
						"  'output_type': type(node['output']).__name__,",
						"  'node_json': json.dumps(node, separators=(',', ':')),",
						"  'view_json': json.dumps(view, separators=(',', ':')),",
						"  'is_dict': isinstance(view, dict),",
						"  'control_in_keys': 'control' in view,",
						"  'has_control': hasattr(view, 'control'),",
						"  'snapshot_text': snapshot['text'],",
						"}))",
					].join("\n"),
				);
				expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
				expect(stdoutJson(messages)).toEqual({
					output_type: "str",
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
					is_dict: true,
					control_in_keys: false,
					has_control: true,
					snapshot_text: "live tail",
				});
				expect(calls[1]).toMatchObject({
					toolName: RESERVED_HANDLE_OUTPUT_TOOL,
					args: { ref: { kind: "agent", id: "st_abc123", run_epoch: 3 }, format: "tail", limit: 5 },
				});
			},
		);
	});

	it("wait() posts refs in input order on a long-lived request that still pauses the run budget", async () => {
		await withPythonBridge(
			(request) => (request.toolName === RESERVED_AGENT_TOOL ? agentReply : ["A", "B", "A"]),
			async (kernel, calls, messages) => {
				const result = await runCell(
					kernel,
					[
						"a = agent('a', handle=True)",
						"b = handle({'kind': 'agent', 'id': 'st_b', 'run_epoch': 0})",
						"wait([a, b, a], timeout=30, mode='settled')",
					].join("\n"),
				);
				expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
				expect(result.ok ? result.valueRepr : undefined).toBe("['A', 'B', 'A']");
				expect(calls[1]).toMatchObject({
					toolName: RESERVED_WAIT_TOOL,
					args: {
						refs: [
							{ kind: "agent", id: "st_abc123", run_epoch: 3 },
							{ kind: "agent", id: "st_b", run_epoch: 0 },
							{ kind: "agent", id: "st_abc123", run_epoch: 3 },
						],
						timeout: 30,
						mode: "settled",
					},
				});
				const ops = messages
					.filter((m): m is Extract<KernelToHostMessage, { type: "status" }> => m.type === "status")
					.map((m) => m.event.op);
				expect(ops.filter((op) => op === "timeout-pause")).toHaveLength(2);
				expect(ops.filter((op) => op === "timeout-resume")).toHaveLength(2);
			},
		);
	});

	it("completion(handle=True) is opt-in and the runner dispatcher no longer shadows handle()", async () => {
		await withPythonBridge(
			() => ({
				ref: { kind: "completion", id: "cp_1", run_epoch: 0 },
				phase: "pending",
				host_status: "running",
				revision: 1,
			}),
			async (kernel, calls, messages) => {
				const result = await runCell(
					kernel,
					[
						"import json",
						"plain = completion('hi')",
						"h = completion('hi', handle=True)",
						"print(json.dumps({'plain': plain, 'handle': h['handle'], 'is_dict': isinstance(h, dict), 'phase': h.control.status()['phase'], 'helper': callable(handle) and handle.__name__}))",
					].join("\n"),
				);
				expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
				expect(stdoutJson(messages)).toEqual({
					plain: "plain answer",
					handle: "completion://cp_1",
					is_dict: true,
					phase: "pending",
					helper: "handle",
				});
				expect(calls.map((call) => call.toolName)).toEqual(["__handle_status__"]);
			},
			{
				onCompletion: (request) =>
					typeof request.opts === "object" &&
					request.opts !== null &&
					"handle" in request.opts &&
					request.opts.handle === true
						? { kind: "completion", id: "cp_1", run_epoch: 0, handle: "completion://cp_1" }
						: "plain answer",
			},
		);
	});

	it("rejects malformed handles and options before any bridge call", async () => {
		await withPythonBridge(
			() => "unused",
			async (kernel, calls) => {
				for (const [code, reason] of [
					["wait([{'id': 'st_x'}])", /handle\(\) expects/u],
					[
						"wait([{'kind': 'agent', 'id': 'st_x', 'run_epoch': -1}])",
						/run_epoch must be a non-negative integer/u,
					],
					["wait([], mode='sometimes')", /mode must be/u],
					["wait([], timeout=float('inf'))", /timeout must be a finite number/u],
					["handle('agent://st_x')", /handle\(\) expects/u],
				] as const) {
					const result = await runCell(kernel, code);
					expect(result.ok, code).toBe(false);
					if (!result.ok) expect(result.error.message, code).toMatch(reason);
				}
				expect(calls).toEqual([]);
			},
		);
	});
});
