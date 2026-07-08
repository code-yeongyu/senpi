import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
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
		expect(runner).toContain('"POST /call HTTP/1.1"');
		expect(runner).toContain('"Authorization: Bearer " * string(token)');
		expect(runner).toContain('"callId" => call_id');
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
});
