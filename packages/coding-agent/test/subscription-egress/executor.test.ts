import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthLaneBoundary } from "../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { createSubscriptionEgressExecutor, providerCallOutputSchema } from "../../src/subscription-egress/index.ts";
import { cancel, outputSink, prepare, request, scope, scripted, sdk, stalled, success } from "./fixtures.ts";

beforeEach(prepare);
afterEach(() => {
	resetSdkBoundary();
	resetAuthLaneBoundary();
	vi.unstubAllEnvs();
});

describe("hand subscription executor (#4998)", () => {
	it.each([undefined, "", "0", "true"])("does not invoke the SDK unless the flag is exactly 1 (%s)", async (flag) => {
		vi.stubEnv("SENPI_EXPERIMENTAL_SUBSCRIPTION_EGRESS", flag);
		const query = scripted([success]);
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		await expect(executor.handle(request)).rejects.toThrow("disabled");
		await expect(executor.handle(cancel())).rejects.toThrow("disabled");
		expect(query).not.toHaveBeenCalled();
		expect(sink.messages).toEqual([]);
		await executor.dispose();
	});

	it("streams through the real provider, with local cwd and subscription usage, without resident mode", async () => {
		const sink = outputSink();
		const query = scripted(
			[
				sdk({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 7 } } } }),
				sdk({
					type: "stream_event",
					event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				}),
				sdk({
					type: "stream_event",
					event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
				}),
				sdk({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
				success,
			],
			(input) => {
				expect(input.options?.cwd).toBe(scope.cwd);
				expect(input.options?.resume).toBeUndefined();
				expect(input.options?.sessionId).toBeUndefined();
			},
		);
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		await executor.handle(request);
		expect(query).toHaveBeenCalledTimes(1);
		expect(sink.messages.map((m) => m.seq)).toEqual(sink.messages.map((_, i) => i));
		expect(sink.messages.some((m) => m.type === "provider.call.event" && m.event.type === "text_delta")).toBe(true);
		expect(sink.messages.at(-1)).toMatchObject({
			type: "provider.call.end",
			billing: "subscription",
			message: {
				content: [{ type: "text", text: "hello" }],
				usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 },
			},
		});
		for (const message of sink.messages) expect(providerCallOutputSchema.safeParse(message).success).toBe(true);
		await expect(executor.handle(request)).rejects.toThrow("duplicate");
		await executor.dispose();
	});

	it("refuses wrong thread, epoch, and remote capabilities before SDK execution", async () => {
		const query = scripted([success]);
		const executor = createSubscriptionEgressExecutor(scope, outputSink().send);
		for (const patch of [{ threadId: "other" }, { epoch: 2 }, { options: { env: { TOKEN: "injected" } } }]) {
			await expect(executor.handle({ ...request, ...patch })).rejects.toThrow();
		}
		expect(query).not.toHaveBeenCalled();
		await executor.dispose();
	});

	it("rejects a concurrent duplicate and cancels only the authorized call", async () => {
		const query = stalled();
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		const running = executor.handle(request);
		try {
			await query.opened;
			await expect(executor.handle(request)).rejects.toThrow("duplicate");
			await expect(executor.handle({ ...cancel(), threadId: "other" })).rejects.toThrow();
			await executor.handle(cancel("different-call"));
			expect(query.interrupted).not.toHaveBeenCalled();
			await executor.handle(cancel());
			await running;
			expect(query.interrupted).toHaveBeenCalledTimes(1);
			expect(query.closed).toHaveBeenCalled();
			expect(sink.messages.filter((m) => m.type !== "provider.call.event")).toHaveLength(1);
			expect(sink.messages.at(-1)).toMatchObject({
				type: "provider.call.error",
				code: "aborted",
				billing: "subscription",
			});
			await executor.handle(cancel());
			expect(query.query).toHaveBeenCalledTimes(1);
		} finally {
			await executor.dispose();
			await running;
		}
	});

	it("disposes active queries and rejects later starts", async () => {
		const query = stalled();
		const executor = createSubscriptionEgressExecutor(scope, outputSink().send);
		const running = executor.handle(request);
		await query.opened;
		await executor.dispose();
		await running;
		expect(query.closed).toHaveBeenCalled();
		await expect(executor.handle({ ...request, callId: "next" })).rejects.toThrow("disposed");
	});

	it("never forwards raw SDK failures or local account diagnostics", async () => {
		scripted([
			sdk({
				type: "result",
				subtype: "error_during_execution",
				errors: ["authentication_failed private-token-example local-path-example"],
				usage: { input_tokens: 4, output_tokens: 1 },
			}),
		]);
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		await executor.handle(request);
		expect(sink.messages.at(-1)).toMatchObject({
			type: "provider.call.error",
			code: "auth",
			billing: "subscription",
			message: { usage: { input: 4, output: 1 } },
		});
		expect(JSON.stringify(sink.messages)).not.toMatch(/private-token-example|local-path-example|diagnostics/);
		await executor.dispose();
	});

	it("keeps SDK tool execution denied while returning tool calls to the caller", async () => {
		let denial: Promise<unknown> | undefined;
		scripted(
			[
				sdk({
					type: "stream_event",
					event: {
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} },
					},
				}),
				sdk({
					type: "stream_event",
					event: {
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"command":"echo hello"}' },
					},
				}),
				sdk({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
				success,
			],
			(input) => {
				const hook = input.options?.hooks?.PreToolUse?.[0]?.hooks[0];
				if (!hook) throw new Error("SDK tool denial hook missing");
				denial = hook(
					{
						hook_event_name: "PreToolUse",
						tool_name: "Bash",
						tool_input: {},
						session_id: "synthetic",
						transcript_path: "",
						cwd: scope.cwd,
						tool_use_id: "tool-1",
					},
					"tool-1",
					{ signal: new AbortController().signal },
				);
			},
		);
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		await executor.handle({
			...request,
			context: {
				...request.context,
				tools: [{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } }],
			},
		});
		expect(await denial).toMatchObject({ continue: false, hookSpecificOutput: { permissionDecision: "deny" } });
		expect(sink.messages.at(-1)).toMatchObject({
			type: "provider.call.end",
			message: { content: [{ type: "toolCall", name: "bash", arguments: { command: "echo hello" } }] },
		});
		await executor.dispose();
	});

	it("snapshots partials and awaits the sink; cancellation beats an unpublished success", async () => {
		const delivered = Promise.withResolvers<void>();
		const releaseSink = Promise.withResolvers<void>();
		const providerFinished = Promise.withResolvers<void>();
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield sdk({
						type: "stream_event",
						event: { type: "message_start", message: { usage: { input_tokens: 1 } } },
					});
					await delivered.promise;
					yield success;
					providerFinished.resolve();
				},
				interrupt: async () => {},
				close: () => {},
			}),
		});
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, async (message) => {
			await sink.send(message);
			if (message.seq === 0) {
				delivered.resolve();
				await releaseSink.promise;
			}
		});
		const running = executor.handle(request);
		try {
			await delivered.promise;
			const snapshot = JSON.stringify(sink.messages[0]);
			await providerFinished.promise;
			expect(sink.messages).toHaveLength(1);
			expect(JSON.stringify(sink.messages[0])).toBe(snapshot);
			await executor.handle(cancel());
			releaseSink.resolve();
			await running;
			expect(sink.messages.at(-1)).toMatchObject({ type: "provider.call.error", code: "aborted" });
			expect(sink.messages.filter((m) => m.type !== "provider.call.event")).toHaveLength(1);
		} finally {
			releaseSink.resolve();
			await executor.dispose();
			await running;
		}
	});

	it("does not cancel another active call on the same attachment", async () => {
		const first = stalled();
		const sink = outputSink();
		const executor = createSubscriptionEgressExecutor(scope, sink.send);
		const runningFirst = executor.handle(request);
		await first.opened;
		const second = stalled();
		const runningSecond = executor.handle({ ...request, callId: "call-b" });
		try {
			await second.opened;
			await executor.handle(cancel());
			await runningFirst;
			expect(second.interrupted).not.toHaveBeenCalled();
			expect(second.closed).not.toHaveBeenCalled();
			await executor.dispose();
			await runningSecond;
			expect(second.interrupted).toHaveBeenCalledTimes(1);
			expect(sink.messages.filter((m) => m.type === "provider.call.error").map((m) => m.callId)).toEqual([
				"call-a",
				"call-b",
			]);
		} finally {
			await executor.dispose();
			await Promise.all([runningFirst, runningSecond]);
		}
	});

	it("disposal waits for every call even if one sink rejects", async () => {
		const first = stalled();
		const failedSink = Promise.withResolvers<void>();
		const secondTerminal = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const executor = createSubscriptionEgressExecutor(scope, async (message) => {
			if (message.type === "provider.call.event") return;
			if (message.callId === "call-a") {
				await failedSink.promise;
				throw new Error("sink failed");
			}
			secondTerminal.resolve();
			await releaseSecond.promise;
		});
		const firstResult = executor.handle(request).catch((error: unknown) => error);
		await first.opened;
		const second = stalled();
		const secondResult = executor.handle({ ...request, callId: "call-b" });
		await second.opened;
		let disposed = false;
		const disposal = executor
			.dispose()
			.finally(() => {
				disposed = true;
			})
			.catch((error: unknown) => error);
		try {
			await secondTerminal.promise;
			failedSink.resolve();
			expect(await firstResult).toBeInstanceOf(Error);
			// The first rejected call is settled, but the second sink still owns delivery.
			expect(disposed).toBe(false);
		} finally {
			releaseSecond.resolve();
			failedSink.resolve();
			await secondResult;
			await disposal;
		}
		expect(await disposal).toBeInstanceOf(AggregateError);
	});
});
