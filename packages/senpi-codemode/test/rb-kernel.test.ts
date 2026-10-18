// allow: SIZE_OK — parity cases stay beside the live kernel harness they exercise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { RubyKernel } from "../src/kernels/rb/kernel.ts";

function hasRuby(): boolean {
	try {
		execFileSync("ruby", ["--version"], { stdio: "ignore", timeout: 3_000 });
		return true;
	} catch {
		return false;
	}
}

/** Runners this test file started: other files' kernels run in parallel workers and are not its leaks. */
function runnerProcessIds(runnerPath: string): Set<string> {
	try {
		const output = execFileSync("pgrep", ["-P", String(process.pid), "-fl", escapeRegExp(runnerPath)], {
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
		const prelude = await readFile(join(import.meta.dirname, "..", "src", "kernels", "rb", "prelude.rb"), "utf8");
		const runner = await readFile(runnerPath, "utf8");
		// The wire bytes the host reads: loopback /call, a bearer token, and the callId/toolName keys.
		expect(prelude).toContain("http://127.0.0.1:");
		expect(prelude).toContain("Bearer ");
		expect(prelude).toContain('"callId" =>');
		expect(prelude).toContain('"toolName" =>');
		expect(runner).not.toContain('"type" => "tool-call"');
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
					await expect(
						kernel.run({ cellId: "set", code: "$answer = 41", timeoutMs: 3_000 }),
					).resolves.toMatchObject({ ok: true });
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

	it.skipIf(!hasRuby())("matches helper, status, markdown, and auto-display contracts", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-kernel-parity-"));
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
			const kernel = RubyKernel.start({
				cwd: root,
				sessionId: "rb-parity",
				connection: { port: server.port, token: server.token, localRoots: { local: localRoot } },
				onMessage: (message) => messages.push(message),
			});
			try {
				// Given: a live kernel with a local:// root and loopback bridge.
				// When: cells exercise the documented Ruby helper and REPL surface.
				const literal = await kernel.run({ cellId: "literal", code: "1 + 1", timeoutMs: 3_000 });
				const assignment = await kernel.run({ cellId: "assignment", code: "answer = 5", timeoutMs: 3_000 });
				const nilValue = await kernel.run({ cellId: "nil", code: "nil", timeoutMs: 3_000 });
				const environment = await kernel.run({
					cellId: "environment",
					code: 'env("SENPI_RB_PARITY", "value"); env("SENPI_RB_PARITY")',
					timeoutMs: 3_000,
				});
				const agent = await kernel.run({
					cellId: "agent",
					code: 'write("local://nested/value.txt", "hello"); agent("summarize")',
					timeoutMs: 3_000,
				});
				const output = await kernel.run({ cellId: "output", code: 'output("st_123")', timeoutMs: 3_000 });
				await kernel.run({
					cellId: "markdown",
					code: 'display({ type: "markdown", text: "# Heading" })',
					timeoutMs: 3_000,
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
				expect(toolCalls).toContainEqual({ toolName: "__agent__", args: { prompt: "summarize", agent: "task" } });
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
	});

	it.skipIf(!hasRuby())(
		"reports the largest globals in the result memory notice when live memory crosses the notice threshold",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "senpi-rb-kernel-globals-"));
			const server = await startBridgeServer({
				token: "live-token",
				onCall: async () => "unexpected",
				onEmit: async () => {},
				onCompletion: async () => {
					throw new Error("unexpected completion");
				},
			});
			const MiB = 1024 * 1024;
			try {
				const kernel = RubyKernel.start({
					cwd: root,
					sessionId: "rb-globals",
					connection: { port: server.port, token: server.token },
					memory: {
						thresholds: { gcWatermarkBytes: 32 * MiB, noticeBytes: 64 * MiB, ceilingBytes: 512 * MiB },
						readFootprint: (pid) => {
							try {
								const status = readFileSync(`/proc/${pid}/status`, "utf8");
								const kb = Number(status.match(/VmRSS:\s*(\d+)/)?.[1]);
								if (Number.isFinite(kb) && kb > 0) return { bytes: kb * 1024 };
							} catch {}
							try {
								const rss = Number(
									execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim(),
								);
								if (Number.isFinite(rss) && rss > 0) return { bytes: rss * 1024 };
							} catch {}
							return undefined;
						},
					},
				});
				try {
					const result = await kernel.run({
						cellId: "big",
						code: '$big_blob = "a" * (128 * 1024 * 1024); nil',
						timeoutMs: 15_000,
					});
					expect(result).toMatchObject({ ok: true });
					expect(result.memory?.globals).toBeDefined();
					expect(result.memory?.globals?.map((global) => global.name)).toContain("$big_blob");
					expect(
						result.memory?.globals?.find((global) => global.name === "$big_blob")?.bytes,
					).toBeGreaterThanOrEqual(128 * MiB);
					expect(result.memory?.notice).toContain("$big_blob");

					const rows = await kernel.run({
						cellId: "rows",
						code: [
							'system("false")',
							'stdout_read.instance_variable_set(:@pad, "p" * 2_000_000)',
							'$LOADED_FEATURES << ("q" * 2_000_000)',
							'big = "x" * 30_000_000',
							// 90,000 nodes: far past one global's walk budget, small enough to stay under the 512 MiB ceiling.
							'nested = Array.new(300) { Array.new(300) { "y" * 10 } }',
							'rows = Array.new(300_000) { |i| "x" * 200 + i.to_s }',
							"nil",
						].join("; "),
						timeoutMs: 30_000,
					});
					const named = rows.memory?.globals ?? [];
					const sizedRows = named.find((global) => global.name === "rows");
					expect(sizedRows?.bytes).toBeGreaterThanOrEqual(60 * MiB);
					expect(sizedRows?.approximate).toBe(true);
					for (const internal of [
						"stdout_read",
						"stdout_write",
						"stderr_read",
						"stderr_write",
						"$stdout",
						"$LOAD_PATH",
						"$LOADED_FEATURES",
						'$"',
					]) {
						expect(named.map((global) => global.name)).not.toContain(internal);
					}
					expect(named.find((global) => global.name === "big")?.bytes).toBeGreaterThanOrEqual(25 * MiB);
					expect(named.map((global) => global.name)).toContain("nested");

					// Numeric leaves count against a global's walk budget like strings do: a 600x600 Integer grid stops
					// early and is reported as an estimate instead of walking all 360,000 leaves on every cell.
					const grid = await kernel.run({
						cellId: "grid",
						code: "int_grid = Array.new(600) { Array.new(600) { |i| i * 1_000_000_007 } }; nil",
						timeoutMs: 30_000,
					});
					expect(grid.memory?.globals?.find((global) => global.name === "int_grid")).toMatchObject({
						approximate: true,
					});

					const status = await kernel.run({ cellId: "status", code: "$?.exitstatus", timeoutMs: 15_000 });
					expect(status).toMatchObject({ ok: true, valueRepr: "1" });
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
	it.skipIf(!hasRuby())("uses the bridge pool width and preserves input order under controlled jitter", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-parallel-width-"));
		const markerReceived = Promise.withResolvers<void>();
		const markerReply = Promise.withResolvers<string>();
		const firstHolds = Promise.withResolvers<void>();
		const held = new Map<number, (value: number | PromiseLike<number>) => void>();
		let releaseAdditionalHolds = false;
		const server = await startBridgeServer({
			token: "parallel-width-token",
			onCall: async (request) => {
				if (request.toolName === "marker") {
					markerReceived.resolve();
					return await markerReply.promise;
				}
				if (request.toolName !== "hold") throw new Error(`unexpected tool call: ${request.toolName}`);
				if (
					typeof request.args !== "object" ||
					request.args === null ||
					Array.isArray(request.args) ||
					!("index" in request.args) ||
					typeof request.args.index !== "number"
				) {
					throw new Error("hold requires a numeric index");
				}
				const index = request.args.index;
				if (releaseAdditionalHolds) return index;
				const deferred = Promise.withResolvers<number>();
				held.set(index, deferred.resolve);
				if (held.size === 2) firstHolds.resolve();
				return await deferred.promise;
			},
			onEmit: async () => undefined,
			onCompletion: async () => "unused",
		});
		const connection = { port: server.port, token: server.token, parallelPoolWidth: 2 };
		const kernel = RubyKernel.start({ cwd: root, sessionId: "parallel-width", connection });
		try {
			// Given: a two-worker pool whose first wave is held by the bridge.
			const run = kernel.run({
				cellId: "parallel-width",
				code: `lock = Mutex.new
active = 0
work = lambda do |index|
  lock.synchronize do
    active += 1
    raise "pool width exceeded" if active > 2
    tool.marker({}) if active == 2
  end
  value = tool.hold({ index: index })
  lock.synchronize { active -= 1 }
  value
end
parallel((0...4).map { |index| -> { work.call(index) } })`,
				timeoutMs: 3_000,
			});

			// When: the first wave is released in reverse completion order.
			await markerReceived.promise;
			markerReply.resolve("marker");
			await firstHolds.promise;
			expect([...held.keys()].sort((left, right) => left - right)).toEqual([0, 1]);
			releaseAdditionalHolds = true;
			const releaseOne = held.get(1);
			const releaseZero = held.get(0);
			if (!releaseOne || !releaseZero) throw new Error("missing first-wave hold");
			releaseOne(1);
			releaseZero(0);

			// Then: the bounded pool completes every thunk while retaining input order.
			await expect(run).resolves.toMatchObject({ ok: true, valueRepr: "[0,1,2,3]" });
		} finally {
			await kernel.close();
			await server.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it.skipIf(!hasRuby())("propagates the lowest-index parallel error after every worker settles", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-parallel-error-"));
		const kernel = RubyKernel.start({
			cwd: root,
			sessionId: "parallel-error",
			connection: { port: 1, token: "unused", parallelPoolWidth: 2 },
		});
		try {
			// Given: a lower-index thunk waiting for a higher-index thunk to fail.
			const result = await kernel.run({
				cellId: "parallel-error",
				code: `gate = Queue.new
low = -> { gate.pop; raise "idx0" }
high = -> { gate << true; raise "idx1" }
parallel([low, high])`,
				timeoutMs: 3_000,
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

	it.skipIf(!hasRuby())("keeps every pipeline stage behind the preceding stage barrier", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-rb-pipeline-barrier-"));
		const kernel = RubyKernel.start({
			cwd: root,
			sessionId: "pipeline-barrier",
			connection: { port: 1, token: "unused", parallelPoolWidth: 2 },
		});
		try {
			// Given: stages that record deterministic logical timestamps in the cell.
			const result = await kernel.run({
				cellId: "pipeline-barrier",
				code: `logical_time = 0
stage_one_ends = []
stage_two_starts = []
stage_one = lambda do |value|
  logical_time += 1
  stage_one_ends << logical_time
  Thread.pass
  value
end
stage_two = lambda do |value|
  logical_time += 1
  stage_two_starts << logical_time
  value
end
values = pipeline([0, 1, 2], stage_one, stage_two)
raise "pipeline barrier failed" unless stage_two_starts.min >= stage_one_ends.max
values`,
				timeoutMs: 3_000,
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
