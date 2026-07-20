import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JuliaKernel } from "../src/kernels/jl/kernel.ts";

function hasJulia(): boolean {
	try {
		execFileSync("julia", ["--version"], { stdio: "ignore", timeout: 3_000 });
		return true;
	} catch {
		return false;
	}
}

describe("JuliaKernel", () => {
	it("routes tool calls through the authenticated loopback bridge contract", async () => {
		const runner = await readFile(join(import.meta.dirname, "..", "src", "kernels", "jl", "runner.jl"), "utf8");
		expect(runner).toContain('connect(ip"127.0.0.1", port)');
		expect(runner).toContain('"POST " * path * " HTTP/1.1"');
		expect(runner).toContain('"Authorization: Bearer " * string(token)');
		expect(runner).toContain('"callId" => "jl-" * string(time_ns())');
		expect(runner).toContain('"toolName" => name');
		expect(runner).not.toContain('"type" => "tool-call"');
	});

	it("ships the stdlib-only prelude asset", async () => {
		await expect(
			access(join(import.meta.dirname, "..", "src", "kernels", "jl", "prelude.jl")),
		).resolves.toBeUndefined();
	});

	it.skipIf(!hasJulia())(
		"persists state, displays last expression, and calls one host tool through the bridge",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-jl-kernel-"));
			const toolCalls: unknown[] = [];
			const server = await startBridgeServer({
				token: "live-token",
				onCall: async (request) => {
					toolCalls.push({ callId: request.callId, toolName: request.toolName, args: request.args });
					return "julia-tool-ok";
				},
				onEmit: async () => {},
				onCompletion: async () => {
					throw new Error("unexpected completion");
				},
			});
			try {
				const kernel = JuliaKernel.start({
					cwd: root,
					sessionId: "jl-live",
					connection: { port: server.port, token: server.token },
				});
				try {
					// The first cell after start() — and the first after reset(), which
					// restarts the subprocess — pays Julia's full cold boot (interpreter
					// startup + prelude/runner compilation), which routinely exceeds 8s on
					// a loaded CI runner. A cell timeout fires restartProcess(), so a tight
					// cold-start budget doesn't just fail that cell: it wedges the ones
					// after it too (observed as flaky "Kernel is closed" / ok:false on
					// "get"). Cold-start cells get a boot-sized budget; warm cells keep 8s
					// so steady-state responsiveness stays covered.
					const coldStartTimeoutMs = 60_000;
					await kernel.run({ cellId: "set", code: "answer = 41", timeoutMs: coldStartTimeoutMs });
					const persisted = await kernel.run({ cellId: "get", code: "answer + 1", timeoutMs: 8_000 });
					expect(persisted).toMatchObject({ ok: true, valueRepr: "42" });
					await kernel.reset();
					const reset = await kernel.run({
						cellId: "reset",
						code: "@isdefined(answer)",
						timeoutMs: coldStartTimeoutMs,
					});
					expect(reset).toMatchObject({ ok: true, valueRepr: "false" });
					await kernel.run({ cellId: "set-again", code: "answer = 41", timeoutMs: 8_000 });

					await expect(
						kernel.run({
							cellId: "tool",
							code: 'tool.echo(Dict("value" => answer))',
							timeoutMs: 8_000,
						}),
					).resolves.toMatchObject({ ok: true, valueRepr: '"julia-tool-ok"' });
					expect(toolCalls).toMatchObject([{ toolName: "echo", args: { value: 41 } }]);
				} finally {
					await kernel.close();
				}
			} finally {
				await server.close();
				await rm(root, { recursive: true, force: true });
			}
		},
	);
	it.skipIf(!hasJulia())(
		"matches helper, status, markdown, and auto-display contracts",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-jl-kernel-parity-"));
			const localRoot = join(root, "local");
			const messages: KernelToHostMessage[] = [];
			const toolCalls: { readonly toolName: string; readonly args: unknown }[] = [];
			const server = await startBridgeServer({
				token: "parity-token",
				onCall: async (request) => {
					toolCalls.push({ toolName: request.toolName, args: request.args });
					return "agent-result";
				},
				onEmit: async () => {},
				onCompletion: async () => "unused",
			});
			try {
				const kernel = JuliaKernel.start({
					cwd: root,
					sessionId: "jl-parity",
					connection: { port: server.port, token: server.token, localRoots: { local: localRoot } },
					onMessage: (message) => messages.push(message),
				});
				try {
					const coldStartTimeoutMs = 60_000;
					const warmTimeoutMs = 8_000;
					// Given: a live kernel with a local:// root and loopback bridge.
					// When: cells exercise the documented Julia helper and REPL surface.
					const literal = await kernel.run({ cellId: "literal", code: "1 + 1", timeoutMs: coldStartTimeoutMs });
					const assignment = await kernel.run({
						cellId: "assignment",
						code: "answer = 5",
						timeoutMs: warmTimeoutMs,
					});
					const nilValue = await kernel.run({ cellId: "nil", code: "nothing", timeoutMs: warmTimeoutMs });
					const environment = await kernel.run({
						cellId: "environment",
						code: 'env("SENPI_JL_PARITY", "value"); env("SENPI_JL_PARITY")',
						timeoutMs: warmTimeoutMs,
					});
					const agent = await kernel.run({
						cellId: "agent",
						code: 'write("local://nested/value.txt", "hello"); agent("summarize")',
						timeoutMs: warmTimeoutMs,
					});
					const output = await kernel.run({
						cellId: "output",
						code: 'output("st_123")',
						timeoutMs: warmTimeoutMs,
					});
					await kernel.run({
						cellId: "markdown",
						code: 'display(Dict("type" => "markdown", "text" => "# Heading"))',
						timeoutMs: warmTimeoutMs,
					});

					// Then: only eligible final expressions auto-display and helpers use the bridge contract.
					expect(literal).toMatchObject({ ok: true, valueRepr: "2" });
					expect(assignment).toMatchObject({ ok: true });
					if (assignment.ok) expect(assignment.valueRepr).toBeUndefined();
					expect(nilValue).toMatchObject({ ok: true });
					if (nilValue.ok) expect(nilValue.valueRepr).toBeUndefined();
					expect(environment).toMatchObject({ ok: true, valueRepr: '"value"' });
					expect(agent).toMatchObject({ ok: true, valueRepr: '"agent-result"' });
					expect(output).toMatchObject({ ok: true, valueRepr: '"agent-result"' });
					expect(toolCalls).toContainEqual({
						toolName: "__agent__",
						args: { prompt: "summarize", agent: "task" },
					});
					expect(toolCalls).toContainEqual({ toolName: "__output__", args: { ids: ["st_123"], format: "raw" } });
					expect(await readFile(join(localRoot, "nested", "value.txt"), "utf8")).toBe("hello");
					expect(messages.some((message) => message.type === "status" && message.event.op === "env")).toBe(true);
					expect(messages.some((message) => message.type === "status" && message.event.op === "write")).toBe(true);
					expect(messages).toContainEqual({
						type: "display",
						mimeType: "text/markdown",
						dataBase64: Buffer.from("# Heading", "utf8").toString("base64"),
					});
				} finally {
					await kernel.close();
				}
			} finally {
				await server.close();
				await rm(root, { recursive: true, force: true });
			}
		},
		120_000,
	);
	it.skipIf(!hasJulia())("preserves input order under cooperative jitter", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-jl-parallel-order-"));
		const kernel = JuliaKernel.start({
			cwd: root,
			sessionId: "parallel-order",
			connection: { port: 1, token: "unused", parallelPoolWidth: 2 },
		});
		try {
			// Given: thunk durations staggered by cooperative scheduler yields.
			const result = await kernel.run({
				cellId: "parallel-order",
				code: `function jitter(index)
    for _ in 1:(4 - index)
        yield()
    end
    index
end
parallel([() -> jitter(index) for index in 0:3])`,
				timeoutMs: 60_000,
			});

			// When: every thunk settles.
			// Then: the result follows input order rather than completion order.
			expect(result).toMatchObject({ ok: true, valueRepr: "[0,1,2,3]" });
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasJulia())("propagates the lowest-index parallel error after every worker settles", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-jl-parallel-error-"));
		const kernel = JuliaKernel.start({
			cwd: root,
			sessionId: "parallel-error",
			connection: { port: 1, token: "unused", parallelPoolWidth: 2 },
		});
		try {
			// Given: a lower-index thunk waiting for a higher-index thunk to fail.
			const result = await kernel.run({
				cellId: "parallel-error",
				code: `gate = Channel{Bool}(1)
low = () -> begin
    take!(gate)
    error("idx0")
end
high = () -> begin
    put!(gate, true)
    error("idx1")
end
parallel([low, high])`,
				timeoutMs: 60_000,
			});

			// When: both thunks raise in controlled opposite completion order.
			// Then: the observable cell error is from the lowest input index.
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("idx0");
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasJulia())("keeps every pipeline stage behind the preceding stage barrier", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-jl-pipeline-barrier-"));
		const kernel = JuliaKernel.start({
			cwd: root,
			sessionId: "pipeline-barrier",
			connection: { port: 1, token: "unused", parallelPoolWidth: 2 },
		});
		try {
			// Given: stages that record deterministic logical timestamps in the cell.
			const result = await kernel.run({
				cellId: "pipeline-barrier",
				code: `logical_time = Ref(0)
stage_one_ends = Int[]
stage_two_starts = Int[]
stage_one = value -> begin
    for _ in 1:(3 - value)
        yield()
    end
    logical_time[] += 1
    push!(stage_one_ends, logical_time[])
    value
end
stage_two = value -> begin
    logical_time[] += 1
    push!(stage_two_starts, logical_time[])
    value
end
values = pipeline([0, 1, 2], stage_one, stage_two)
minimum(stage_two_starts) >= maximum(stage_one_ends) || error("pipeline barrier failed")
values`,
				timeoutMs: 60_000,
			});

			// When: both pipeline stages run.
			// Then: stage two starts only after every stage-one completion.
			expect(result).toMatchObject({ ok: true, valueRepr: "[0,1,2]" });
		} finally {
			await kernel.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
