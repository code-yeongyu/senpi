import { afterEach, describe, expect, it } from "vitest";
import { toolResultHandlerTimeoutMs, waitForToolHook } from "../../../src/core/extensions/tool-hook-wait.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { createHarness, type Harness } from "../harness.ts";
import { hookEnds, probeTurnHarness, withinRealTime } from "./omo-14354-tool-hook-support.ts";

/**
 * oh-my-openagent#14354: a tool hook handler that never settles used to hold the tool loop forever, and neither Esc
 * nor an RPC interrupt ended the wait.
 */
const never = (): Promise<undefined> => new Promise(() => {});
const TIMEOUT_ENV = "SENPI_TOOL_RESULT_HANDLER_TIMEOUT_MS";
const assistantTexts = (harness: Harness): string[] =>
	harness.session.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
		.flatMap((block) => (block.type === "text" ? [block.text] : []));

let harness: Harness | undefined;
const savedTimeout = process.env[TIMEOUT_ENV];
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	if (savedTimeout === undefined) delete process.env[TIMEOUT_ENV];
	else process.env[TIMEOUT_ENV] = savedTimeout;
});

describe("oh-my-openagent#14354: a tool hook handler cannot hold the tool loop", () => {
	it("gives up on a tool_result handler at its deadline, keeps the tool result and runs the next handler", async () => {
		process.env[TIMEOUT_ENV] = "1";
		let nextRan = false;
		const turn = await probeTurnHarness([
			{ path: "<hung>", factory: (pi) => void pi.on("tool_result", never) },
			{
				path: "<next>",
				factory: (pi) =>
					void pi.on("tool_result", () => {
						nextRan = true;
						return undefined;
					}),
			},
		]);
		harness = turn.harness;
		await withinRealTime(turn.harness.session.prompt("go"), "the turn behind a hung tool_result handler");
		expect(turn.runs).toEqual(["call_probe"]);
		expect(nextRan).toBe(true);
		expect(assistantTexts(turn.harness)).toContain("done");
		expect(turn.errors.map((error) => [error.extensionPath, error.event])).toEqual([["<hung>", "tool_result"]]);
		expect(hookEnds(turn.harness)).toContain("<hung>:PostToolUse:failed");
	});

	it("ends the wait on a tool_result handler when the turn is aborted, and the handler sees the abort", async () => {
		const entered = Promise.withResolvers<AbortSignal | undefined>();
		const turn = await probeTurnHarness([
			{
				path: "<hung>",
				factory: (pi) =>
					void pi.on("tool_result", (_event, ctx) => {
						entered.resolve(ctx.signal);
						return never();
					}),
			},
		]);
		harness = turn.harness;
		const prompting = turn.harness.session.prompt("go");
		const signal = await withinRealTime(entered.promise, "the tool_result handler to start");
		await turn.harness.session.abort();
		await withinRealTime(prompting, "the aborted turn");
		expect(signal?.aborted).toBe(true);
		expect(turn.errors).toEqual([]);
	});

	it("still runs the tool_result handlers of a tool the abort cut, as before", async () => {
		const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
		const running = Promise.withResolvers<void>();
		const heldTool: AgentTool = {
			name: "held",
			label: "Held",
			description: "Returns when its call is aborted.",
			parameters: Type.Object({}),
			execute: (_toolCallId, _params, signal) =>
				new Promise((resolve) => {
					running.resolve();
					signal?.addEventListener(
						"abort",
						() => resolve({ content: [{ type: "text", text: "cut" }], details: {} }),
						{
							once: true,
						},
					);
				}),
		};
		let resultHandlerRan = false;
		harness = await createHarness({
			tools: [heldTool],
			extensionFactories: [
				{
					path: "<observer>",
					factory: (pi) =>
						void pi.on("tool_result", () => {
							resultHandlerRan = true;
							return undefined;
						}),
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("held", {}, { id: "call_held" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("never", { stopReason: "stop" }),
		]);
		const prompting = harness.session.prompt("go");
		await withinRealTime(running.promise, "the held tool to start");
		await harness.session.abort();
		await withinRealTime(prompting, "the aborted turn");
		expect(resultHandlerRan).toBe(true);
		expect(hookEnds(harness)).toEqual(["<observer>:PostToolUse:completed"]);
	});

	it("ends the wait on a tool_call handler when the turn is aborted, and the tool does not run", async () => {
		const entered = Promise.withResolvers<void>();
		const turn = await probeTurnHarness([
			{
				path: "<gate>",
				factory: (pi) =>
					void pi.on("tool_call", () => {
						entered.resolve();
						return never();
					}),
			},
		]);
		harness = turn.harness;
		const prompting = turn.harness.session.prompt("go");
		await withinRealTime(entered.promise, "the tool_call handler to start");
		await turn.harness.session.abort();
		await withinRealTime(prompting, "the aborted turn");
		expect(turn.runs).toEqual([]);
	});
});

describe("waitForToolHook", () => {
	it("discards what an abandoned handler later returns or throws", async () => {
		const late = Promise.withResolvers<string>();
		const controller = new AbortController();
		const waiting = waitForToolHook({ run: () => late.promise, signal: controller.signal, timeoutMs: 0 });
		controller.abort();
		expect(await waiting).toEqual({ kind: "aborted" });
		late.reject(new Error("late failure"));
		await expect(late.promise).rejects.toThrow("late failure");
	});

	it("passes a timely result and a timely failure through", async () => {
		expect(await waitForToolHook({ run: () => "ok", timeoutMs: 60_000 })).toEqual({ kind: "settled", value: "ok" });
		const failure = new Error("boom");
		expect(await waitForToolHook({ run: () => Promise.reject(failure), timeoutMs: 60_000 })).toEqual({
			kind: "failed",
			error: failure,
		});
	});

	it("sets no host deadline for the builtin hooks extension, whose command hooks carry their own timeout", () => {
		expect(toolResultHandlerTimeoutMs("<builtin:hooks>", { [TIMEOUT_ENV]: "5" })).toBe(0);
		expect(toolResultHandlerTimeoutMs("/ext/other.ts", { [TIMEOUT_ENV]: "5" })).toBe(5);
		expect(toolResultHandlerTimeoutMs("/ext/other.ts", {})).toBe(120_000);
	});
});
