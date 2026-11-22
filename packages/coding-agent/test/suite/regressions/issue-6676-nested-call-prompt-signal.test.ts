import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

describe("a nested call's permission prompt follows the call's own signal (senpi#6676)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("cancelling only the nested call ends its prompt and the call does not run", async () => {
		const nested = new AbortController();
		let probe = "";
		let outcome = "";
		const harness = await createHarness({
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
			extensionFactories: [
				permissionSystemExtension,
				(pi) => {
					pi.registerTool({
						name: "outer",
						label: "Outer",
						description: "Writes a probe through a nested call with its own signal",
						parameters: Type.Object({}),
						async execute(_toolCallId, _input, _signal, _onUpdate, ctx) {
							try {
								await ctx.executeTool("write", { path: probe, content: "probe" }, { signal: nested.signal });
								outcome = "ran";
							} catch (error) {
								outcome = error instanceof Error ? error.name : "error";
							}
							return { content: [{ type: "text", text: outcome }], details: {} };
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
		nested.abort();
		const settled = await Promise.race([
			turn.then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
		]);

		expect({
			promptAbortedWithCall: promptSignal?.aborted,
			turnSignalAborted: harness.session.agent.signal?.aborted ?? false,
			settled,
			wrote: existsSync(probe),
		}).toEqual({ promptAbortedWithCall: true, turnSignalAborted: false, settled: "settled", wrote: false });
	});
});
