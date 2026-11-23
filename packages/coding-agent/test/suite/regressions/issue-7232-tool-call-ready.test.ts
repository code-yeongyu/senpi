import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7232 review M1: an observer had no way to learn the path a model write runs with after a tool_call handler
// redirected it, before the tool writes it.
describe("tool_call_ready (senpi#7232)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("carries the redirected arguments before the tool runs, as a copy, and is not fired for a blocked call", async () => {
		const executed: string[] = [];
		const ready: Array<{ toolCallId: string; toolName: string; path: unknown; executedBefore: number }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						if (Reflect.get(event.input, "path") === "blocked.ts") return { block: true, reason: "not this one" };
						Reflect.set(event.input, "path", "redirected.ts");
						return undefined;
					});
				},
				(pi) => {
					pi.on("tool_call_ready", (event) => {
						ready.push({
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							path: event.input.path,
							executedBefore: executed.length,
						});
						event.input.path = "tampered.ts";
					});
					pi.registerTool({
						name: "probe",
						label: "Probe",
						description: "Records the path it runs with",
						parameters: Type.Object({ path: Type.String() }),
						async execute(_toolCallId, input) {
							executed.push(input.path);
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", { path: "requested.ts" }, { id: "runs" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("probe", { path: "blocked.ts" }, { id: "blocked" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("probe twice");

		expect({ ready, executed }).toEqual({
			ready: [{ toolCallId: "runs", toolName: "probe", path: "redirected.ts", executedBefore: 0 }],
			executed: ["redirected.ts"],
		});
	});
});
