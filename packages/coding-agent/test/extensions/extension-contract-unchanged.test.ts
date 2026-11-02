import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/index.ts";
import { sessionExecutor } from "../execution/executor-harness.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

// K4.b: the prepared executor adds no extension-visible preparation capability. An extension observes the same API,
// the same `tool_call` / `tool_result` events and the same handler context through the executor as through today's
// loop. Tool lifecycle events (`tool_execution_*`) stay the loop's to emit and are not part of this comparison.
interface Observation {
	readonly api: readonly string[];
	readonly events: unknown[];
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const echo: AgentTool = {
	name: "echo",
	label: "echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text: `tool:${text}` }], details: { text } };
	},
};

function observer(observation: { api: string[]; events: unknown[] }): ExtensionFactory {
	return (pi) => {
		observation.api.push(...Object.keys(pi).sort());
		pi.on("tool_call", (event, ctx) => {
			observation.events.push({ event: structuredClone(event), context: Object.keys(ctx).sort() });
		});
		pi.on("tool_result", (event, ctx) => {
			const { usage: _usage, ...stable } = event;
			observation.events.push({ event: structuredClone(stable), context: Object.keys(ctx).sort() });
		});
	};
}

async function observedHarness(): Promise<{ harness: Harness; observation: Observation }> {
	const observation = { api: [] as string[], events: [] as unknown[] };
	const harness = await createHarness({ tools: [echo], extensionFactories: [observer(observation)] });
	harnesses.push(harness);
	return { harness, observation };
}

describe("K4.b: the extension contract is unchanged on the prepared executor", () => {
	it("shows an extension the same API, events and handler context as today's loop", async () => {
		// Given
		const legacy = await observedHarness();
		legacy.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }, { id: "k4b" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const prepared = await observedHarness();
		const executor = await sessionExecutor(prepared.harness.session);

		// When
		await legacy.harness.session.prompt("run echo");
		await executor.prepare("k4b", "echo", { text: "hi" });
		await executor.release("k4b");

		// Then
		expect(prepared.observation.events).toHaveLength(2);
		expect(prepared.observation).toEqual(legacy.observation);
	});
});
