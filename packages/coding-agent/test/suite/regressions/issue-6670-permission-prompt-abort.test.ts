import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

// senpi#6670 / oh-my-openagent#13441: a permission prompt nobody answers (a child's dialog forwarded to a host that
// never shows it, a remote viewer) must end when the turn is aborted. The prompt has to carry the turn's abort
// signal, or an abort cannot release it and the session never settles.
describe("an unanswered permission prompt ends when the turn is aborted (senpi#6670)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("the prompt gets the turn's abort signal and abort settles the turn without running the call", async () => {
		const harness = await createHarness({
			extensionFlagValues: new Map([["permission-preset", "ask"]]),
			extensionFactories: [permissionSystemExtension],
		});
		harnesses.push(harness);
		const asked = Promise.withResolvers<AbortSignal | undefined>();
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: (_title, _options, opts) => {
					asked.resolve(opts?.signal);
					return new Promise<string | undefined>((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(undefined));
					});
				},
			}),
		});
		const probe = join(harness.tempDir, "probe.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: probe, content: "probe" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const turn = harness.session.prompt("write the probe");
		const signal = await asked.promise;
		const aborted = harness.session.abort();
		const settled = await Promise.race([
			Promise.all([aborted, turn.catch(() => undefined)]).then(() => "settled" as const),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
		]);

		expect({
			hasSignal: signal !== undefined,
			signalAborted: signal?.aborted,
			settled,
			wrote: existsSync(probe),
		}).toEqual({
			hasSignal: true,
			signalAborted: true,
			settled: "settled",
			wrote: false,
		});
	});
});
