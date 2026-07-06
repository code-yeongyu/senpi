import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import { RubyKernel } from "../src/kernels/rb/kernel.ts";

function hasRuby(): boolean {
	try {
		execFileSync("ruby", ["--version"], { stdio: "ignore", timeout: 3_000 });
		return true;
	} catch {
		return false;
	}
}

function runnerProcessIds(runnerPath: string): Set<string> {
	try {
		const output = execFileSync("pgrep", ["-fl", escapeRegExp(runnerPath)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3_000,
		});
		return new Set(
			output
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split(/\s+/u)[0])
				.filter((pid) => pid !== undefined),
		);
	} catch {
		return new Set();
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

describe("RubyKernel", () => {
	const runnerPath = join(import.meta.dirname, "..", "src", "kernels", "rb", "runner.rb");

	it("routes tool calls through the authenticated loopback bridge contract", async () => {
		const runner = await readFile(runnerPath, "utf8");
		expect(runner).toContain('URI("http://127.0.0.1:#{port}/call")');
		expect(runner).toContain('request["authorization"] = "Bearer #{token}"');
		expect(runner).toContain('"callId" => call_id');
		expect(runner).toContain('"toolName" => name');
		expect(runner).not.toContain('"type" => "tool-call"');
	});

	it("ships the stdlib-only prelude asset", async () => {
		await expect(
			access(join(import.meta.dirname, "..", "src", "kernels", "rb", "prelude.rb")),
		).resolves.toBeUndefined();
	});

	it.skipIf(!hasRuby())(
		"persists state, displays last expression, and calls one host tool through the bridge",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-rb-kernel-"));
			const toolCalls: unknown[] = [];
			const server = await startBridgeServer({
				token: "live-token",
				onCall: async (request) => {
					toolCalls.push({ callId: request.callId, toolName: request.toolName, args: request.args });
					return "ruby-tool-ok";
				},
				onEmit: async () => {},
				onCompletion: async () => {
					throw new Error("unexpected completion");
				},
			});
			try {
				const kernel = RubyKernel.start({
					cwd: root,
					sessionId: "rb-live",
					connection: { port: server.port, token: server.token },
				});
				try {
					await kernel.run({ cellId: "set", code: "$answer = 41", timeoutMs: 3_000 });
					const persisted = await kernel.run({ cellId: "get", code: "$answer + 1", timeoutMs: 3_000 });
					expect(persisted).toMatchObject({ ok: true, valueRepr: "42" });
					await kernel.reset();
					const reset = await kernel.run({ cellId: "reset", code: "defined?($answer)", timeoutMs: 3_000 });
					expect(reset).toMatchObject({ ok: true });
					if (reset.ok) expect(reset.valueRepr).toBeUndefined();
					await kernel.run({ cellId: "set-again", code: "$answer = 41", timeoutMs: 3_000 });

					await expect(
						kernel.run({ cellId: "tool", code: "tool.echo({value: $answer})", timeoutMs: 3_000 }),
					).resolves.toMatchObject({ ok: true, valueRepr: '"ruby-tool-ok"' });
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

	it.skipIf(!hasRuby())("does not leave runner.rb alive after a timeout restart and close", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-kernel-cleanup-"));
		const server = await startBridgeServer({
			token: "live-token",
			onCall: async () => "unexpected",
			onEmit: async () => {},
			onCompletion: async () => {
				throw new Error("unexpected completion");
			},
		});
		const before = runnerProcessIds(runnerPath);
		try {
			const kernel = RubyKernel.start({
				cwd: root,
				sessionId: "rb-cleanup",
				connection: { port: server.port, token: server.token },
			});
			try {
				const timedOut = await kernel.run({ cellId: "timeout", code: "sleep 10", timeoutMs: 50 });
				expect(timedOut).toMatchObject({
					ok: false,
					error: { message: "Cell timed out after 50ms" },
				});
			} finally {
				await kernel.close();
			}

			const after = runnerProcessIds(runnerPath);
			for (const pid of before) after.delete(pid);
			expect([...after]).toEqual([]);
		} finally {
			await server.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
