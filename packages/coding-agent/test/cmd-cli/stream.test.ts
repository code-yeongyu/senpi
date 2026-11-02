import { createServer } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CmdCliProcessExitError,
	CmdCliResultError,
	flattenContextPrompt,
	streamCmdCli,
} from "../../src/core/extensions/builtin/cmd-cli/stream.ts";

const testModel: Model<Api> = {
	id: "default",
	name: "Command Code CLI (Default)",
	api: "cmd-cli" as Api,
	provider: "cmd-cli",
	baseUrl: "cmd-cli",
	reasoning: true,
	input: ["text"],
	cost: { input: 0.001, output: 0.002, cacheRead: 0.0005, cacheWrite: 0.001 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

async function collectStreamEvents(stream: ReturnType<typeof streamCmdCli>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

describe("cmd-cli stream", () => {
	let tempDir: string;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "cmd-cli-stream-test-"));
	});

	afterAll(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	function createFakeExecutable(scriptContent: string, name = "fake-cmd"): string {
		const scriptPath = join(tempDir, `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
		const fullContent = `#!/usr/bin/env node\n${scriptContent}`;
		writeFileSync(scriptPath, fullContent, { mode: 0o755 });
		chmodSync(scriptPath, 0o755);
		return scriptPath;
	}

	async function abortOnFirstDelta(
		stream: AsyncIterable<{ type: string }>,
		controller: AbortController,
	): Promise<void> {
		for await (const event of stream) {
			if (event.type === "text_delta") controller.abort();
		}
	}

	describe("flattenContextPrompt", () => {
		it("extracts a single user message", () => {
			const context: Context = {
				messages: [{ role: "user", content: "Hello world", timestamp: 1 }],
			};
			expect(flattenContextPrompt(context)).toBe("Hello world");
		});

		it("joins multiple trailing user messages with newlines", () => {
			const context: Context = {
				messages: [
					{ role: "user", content: "Prompt part 1", timestamp: 1 },
					{ role: "user", content: "Prompt part 2", timestamp: 2 },
				],
			};
			expect(flattenContextPrompt(context)).toBe("Prompt part 1\n\nPrompt part 2");
		});

		it("extracts text blocks from user messages", () => {
			const context: Context = {
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Block 1" },
							{ type: "text", text: "Block 2" },
						],
						timestamp: 1,
					},
				],
			};
			expect(flattenContextPrompt(context)).toBe("Block 1\nBlock 2");
		});

		const priorAssistant = (text: string): Context["messages"][number] => ({
			role: "assistant",
			content: [
				{ type: "text", text },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
			],
			api: "cmd-cli" as Api,
			provider: "cmd-cli",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		it("keeps the system prompt, earlier turns, tool calls and tool results before the request", () => {
			const prompt = flattenContextPrompt({
				systemPrompt: "SYSTEM-SENTINEL",
				messages: [
					{ role: "user", content: "HISTORY-SENTINEL", timestamp: 1 },
					priorAssistant("ASSISTANT-SENTINEL"),
					{
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "TOOL-SENTINEL" }],
						isError: false,
						timestamp: 3,
					},
					{ role: "user", content: "FINAL-REQUEST", timestamp: 4 },
				],
			} as Context);
			for (const sentinel of [
				"SYSTEM-SENTINEL",
				"HISTORY-SENTINEL",
				"ASSISTANT-SENTINEL",
				"[tool call read]",
				"TOOL-SENTINEL",
			]) {
				expect(prompt).toContain(sentinel);
			}
			expect(prompt.endsWith("FINAL-REQUEST")).toBe(true);
		});

		it("keeps the history when the context does not end with a user message", () => {
			const prompt = flattenContextPrompt({
				messages: [{ role: "user", content: "Prior user message", timestamp: 1 }, priorAssistant("Prior answer")],
			});
			expect(prompt).toContain("Prior user message");
			expect(prompt).toContain("Prior answer");
		});

		it("marks an image it cannot forward instead of dropping it silently", () => {
			const prompt = flattenContextPrompt({
				messages: [{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }], timestamp: 1 }],
			});
			expect(prompt).toContain("image omitted");
		});
	});

	describe("fake executable streaming", () => {
		it("asserts text deltas stream and usage maps from the result line", async () => {
			const fakeScript = `
process.stdout.write(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "Hello " } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "from fake cmd!" } }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  usage: {
    inputTokens: 1500,
    outputTokens: 250,
    cacheReadTokens: 400,
    cacheWriteTokens: 100
  },
  stopReason: "stop"
}) + "\\n");
process.exit(0);
`;
			const executable = createFakeExecutable(fakeScript, "success-cmd");
			const context: Context = {
				messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
			};

			const stream = streamCmdCli(testModel, context, {}, { resolveExecutable: () => executable });
			const events = await collectStreamEvents(stream);

			expect(events.length).toBeGreaterThanOrEqual(5);
			expect(events[0].type).toBe("start");
			expect(events[1].type).toBe("text_start");

			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas).toHaveLength(2);
			if (textDeltas[0].type === "text_delta") {
				expect(textDeltas[0].delta).toBe("Hello ");
			}
			if (textDeltas[1].type === "text_delta") {
				expect(textDeltas[1].delta).toBe("from fake cmd!");
			}

			const textEnd = events.find((e) => e.type === "text_end");
			expect(textEnd).toBeDefined();
			if (textEnd && textEnd.type === "text_end") {
				expect(textEnd.content).toBe("Hello from fake cmd!");
			}

			const done = events.find((e) => e.type === "done");
			expect(done).toBeDefined();
			if (done && done.type === "done") {
				expect(done.reason).toBe("stop");
				expect(done.message.usage.input).toBe(1500);
				expect(done.message.usage.output).toBe(250);
				expect(done.message.usage.cacheRead).toBe(400);
				expect(done.message.usage.cacheWrite).toBe(100);
				expect(done.message.usage.totalTokens).toBe(1500 + 250 + 400 + 100);
				expect(done.message.usage.cost).toBeDefined();
			}
		});

		it("asserts non-zero exit surfaces typed CmdCliProcessExitError", async () => {
			const fakeScript = `
process.stderr.write("Fatal error: connection failed\\n");
process.exit(42);
`;
			const executable = createFakeExecutable(fakeScript, "error-cmd");
			const context: Context = {
				messages: [{ role: "user", content: "Fail", timestamp: 1 }],
			};

			const stream = streamCmdCli(testModel, context, {}, { resolveExecutable: () => executable });
			let thrownError: unknown;
			try {
				await collectStreamEvents(stream);
			} catch (error) {
				thrownError = error;
			}
			expect(thrownError).toBeInstanceOf(CmdCliProcessExitError);
			const exitError = thrownError as CmdCliProcessExitError;
			expect(exitError.kind).toBe("process_exit");
			expect(exitError.exitCode).toBe(42);
			expect(exitError.stderr).toContain("Fatal error: connection failed");
		});

		it("asserts non-success result subtype surfaces typed CmdCliResultError", async () => {
			const fakeScript = `
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "rate_limit_exceeded",
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}) + "\\n");
process.exit(0);
`;
			const executable = createFakeExecutable(fakeScript, "quota-error-cmd");
			const context: Context = {
				messages: [{ role: "user", content: "Test", timestamp: 1 }],
			};

			const stream = streamCmdCli(testModel, context, {}, { resolveExecutable: () => executable });
			let thrownError: unknown;
			try {
				await collectStreamEvents(stream);
			} catch (error) {
				thrownError = error;
			}
			expect(thrownError).toBeInstanceOf(CmdCliResultError);
			const resultError = thrownError as CmdCliResultError;
			expect(resultError.kind).toBe("result_error");
			expect(resultError.subtype).toBe("rate_limit_exceeded");
		});

		it("asserts abort kills the child process", async () => {
			const fakeScript = `
process.on("SIGTERM", () => {
  process.exit(0);
});
process.stdout.write(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "ready" } }) + "\\n");
setInterval(() => {}, 1000);
`;
			const executable = createFakeExecutable(fakeScript, "hanging-cmd");
			const context: Context = {
				messages: [{ role: "user", content: "Wait", timestamp: 1 }],
			};

			const abortController = new AbortController();
			const stream = streamCmdCli(
				testModel,
				context,
				{ signal: abortController.signal },
				{ resolveExecutable: () => executable, abortGraceMs: 100 },
			);
			await expect(abortOnFirstDelta(stream, abortController)).rejects.toThrow(/aborted/);
		});

		it("asserts abort escalates from SIGTERM to SIGKILL when child ignores SIGTERM", async () => {
			const fakeScript = `
process.on("SIGTERM", () => {});
process.stdout.write(JSON.stringify({ type: "event", event: { type: "text_delta", delta: "ready" } }) + "\\n");
setInterval(() => {}, 1000);
`;
			const executable = createFakeExecutable(fakeScript, "ignoring-cmd");
			const context: Context = {
				messages: [{ role: "user", content: "Wait", timestamp: 1 }],
			};

			const abortController = new AbortController();
			const stream = streamCmdCli(
				testModel,
				context,
				{ signal: abortController.signal },
				{ resolveExecutable: () => executable, abortGraceMs: 50 },
			);
			await expect(abortOnFirstDelta(stream, abortController)).rejects.toThrow(/aborted/);
		});

		it("kills a descendant that ignores SIGTERM once the group leader has exited", async () => {
			const socketPath = join(tempDir, "descendant.sock");
			const descendant = `process.on("SIGTERM", () => {}); require("node:net").connect(${JSON.stringify(socketPath)}); setInterval(() => {}, 1000);`;
			const executable = createFakeExecutable(
				`
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
				"group-leader",
			);
			const abortController = new AbortController();
			const descendantGone = new Promise<void>((resolve) => {
				const server = createServer((socket) => {
					socket.on("error", () => {});
					socket.on("close", () => {
						server.close();
						resolve();
					});
					abortController.abort();
				});
				server.listen(socketPath);
			});

			// The grace period outlasts the test, so only cleanup at leader close can end the descendant.
			const stream = streamCmdCli(
				testModel,
				{ messages: [{ role: "user", content: "Wait", timestamp: 1 }] },
				{ signal: abortController.signal },
				{ resolveExecutable: () => executable, abortGraceMs: 600_000 },
			);

			await expect(collectStreamEvents(stream)).rejects.toThrow(/aborted/);
			await descendantGone;
		});

		it("delivers the flattened context to the worker through stdin", async () => {
			const executable = createFakeExecutable(
				`
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", finalText: input }) + "\\n");
});
`,
				"stdin-cmd",
			);
			const large = "x".repeat(300 * 1024);
			const events = await collectStreamEvents(
				streamCmdCli(
					testModel,
					{ systemPrompt: large, messages: [{ role: "user", content: "REQUEST", timestamp: 1 }] },
					{},
					{ resolveExecutable: () => executable },
				),
			);
			const delta = events.find((event) => event.type === "text_delta");
			expect(delta?.type === "text_delta" && delta.delta.includes(large) && delta.delta.endsWith("REQUEST")).toBe(
				true,
			);
		});

		it("fails instead of reporting an empty success when output is malformed", async () => {
			const executable = createFakeExecutable(`process.stdout.write("{broken\\n");`, "broken-cmd");
			const stream = streamCmdCli(
				testModel,
				{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
				{},
				{ resolveExecutable: () => executable },
			);
			await expect(collectStreamEvents(stream)).rejects.toBeInstanceOf(CmdCliResultError);
		});

		it("fails immediately when stream options signal is already aborted", async () => {
			const abortController = new AbortController();
			abortController.abort();
			const context: Context = {
				messages: [{ role: "user", content: "Aborted", timestamp: 1 }],
			};

			const stream = streamCmdCli(
				testModel,
				context,
				{ signal: abortController.signal },
				{ resolveExecutable: () => "/bin/does-not-matter" },
			);

			await expect(collectStreamEvents(stream)).rejects.toThrow(/aborted/);
		});
	});
});
