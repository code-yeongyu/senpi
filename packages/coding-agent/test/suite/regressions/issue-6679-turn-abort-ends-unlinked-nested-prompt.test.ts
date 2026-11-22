import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

// senpi#6679 M1: a nested call may pass its own, unlinked signal (ExecuteToolOptions.signal). The nested prompt's
// signal must be the union of the call's and the turn's: aborting the TURN alone ends the nested prompt — an
// "Allow once" after the abort would otherwise run the nested write — while the call's own signal still ends it
// alone (#6676). The union must not abort the caller's original controllers.
describe("a turn abort ends a nested prompt whose signal is unlinked (senpi#6679)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("aborting the turn alone ends the nested call's prompt and the write never runs", async () => {
		const nested = new AbortController();
		let probe = "";
		const harness = await createHarness({
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
			extensionFactories: [
				permissionSystemExtension,
				(pi) => {
					pi.registerTool({
						name: "outer",
						label: "Outer",
						description: "Writes a probe through a nested call with an unlinked signal",
						parameters: Type.Object({}),
						async execute(_toolCallId, _input, _signal, _onUpdate, ctx) {
							try {
								await ctx.executeTool("write", { path: probe, content: "probe" }, { signal: nested.signal });
							} catch {
								// expected: the nested call ends with the turn; its outcome is not this test's subject
							}
							return { content: [{ type: "text", text: "outer done" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		probe = join(harness.tempDir, "probe.txt");
		const prompts: Array<AbortSignal | undefined> = [];
		const nestedAsked = Promise.withResolvers<AbortSignal | undefined>();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: (_title, _options, opts) => {
					prompts.push(opts?.signal);
					if (prompts.length === 1) return Promise.resolve("Allow once");
					nestedAsked.resolve(opts?.signal);
					return new Promise<string | undefined>((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(undefined));
					});
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("outer", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const turn = harness.session.prompt("run outer");
		const promptSignal = await nestedAsked.promise;
		const aborted = harness.session.abort();
		const settled = await Promise.race([
			Promise.all([aborted, turn.catch(() => undefined)]).then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
		]);

		expect({
			promptAbortedWithTurn: promptSignal?.aborted,
			callSignalAborted: nested.signal.aborted,
			settled,
			wrote: existsSync(probe),
		}).toEqual({
			promptAbortedWithTurn: true,
			callSignalAborted: false,
			settled: "settled",
			wrote: false,
		});
	});
});
