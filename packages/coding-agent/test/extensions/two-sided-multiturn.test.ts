// S29 (brain/hand split, C7(c), R24.b): an unmodified multi-turn extension keeps one closure on a split session.
// The closure-ext fixture is loaded by path on both sides, never edited per placement. Turn one's tool_result writes
// its state where the loop runs (forwarded from the hand), and turn two's provider request reads that same state.
import { fileURLToPath } from "node:url";
import { type AgentTool, createRemoteToolHost } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../src/core/extensions/loader.ts";
import { EXTENSION_EVENTS_PLANE, serveExtensionEvents } from "../../src/core/extensions/two-sided-forwarding.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { cleanupHands, handDirs, openLink, startHand } from "../hand/remote-hand-fixture.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";
import { createTestResourceLoader } from "../utilities.ts";

const closureExt = fileURLToPath(new URL("../fixtures/closure-ext/index.ts", import.meta.url));

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await cleanupHands();
});

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo the arguments back",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params) => ({ content: [{ type: "text", text: JSON.stringify(params) }], details: {} }),
};
const echoOnHand: ExtensionFactory = (pi) => {
	pi.registerTool(echo);
};

interface Trace {
	readonly toolText: string;
	readonly resultDetails: unknown;
	readonly providerClosureLines: string[];
}

const closureLine = (systemPrompt: string): string =>
	systemPrompt.split("\n").find((line) => line.startsWith("closure-ext ")) ?? "<missing>";

async function runTwoTurns(placement: "fused" | "split-local"): Promise<Trace> {
	const extensionsResult = await loadExtensions([closureExt], process.cwd());
	expect(extensionsResult.errors).toEqual([]);
	const harness = await createHarness({
		tools: [echo],
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	harnesses.push(harness);
	if (placement === "split-local") {
		const link = openLink();
		startHand(link, await handDirs("s29-multiturn"), [echoOnHand], ["-e", closureExt]);
		harness.agent.toolHost = createRemoteToolHost({
			transport: link.brain,
			placement: "split-local",
			planes: { [EXTENSION_EVENTS_PLANE]: serveExtensionEvents(harness.getExtensionRunner()) },
		});
	}
	const providerClosureLines: string[] = [];
	harness.setResponses([
		(context) => {
			providerClosureLines.push(closureLine(getCurrentSystemPrompt(context.messages)));
			return fauxAssistantMessage([fauxToolCall("echo", { n: 0 })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("turn one done"),
		(context) => {
			providerClosureLines.push(closureLine(getCurrentSystemPrompt(context.messages)));
			return fauxAssistantMessage("turn two done");
		},
	]);
	await harness.session.prompt("call echo");
	const result = getToolResult(harness, "echo");
	await harness.session.prompt("what did the tool see?");
	const toolText = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	return { toolText, resultDetails: result.details, providerClosureLines };
}

describe("an unmodified multi-turn two-sided extension on a split session (S29, R24.b)", () => {
	it("turn one's tool_result state reaches turn two's provider request, as fused", async () => {
		const fused = await runTwoTurns("fused");

		expect(fused).toEqual({
			toolText: '{"n":1}',
			resultDetails: { n: 1 },
			providerClosureLines: ["closure-ext turn=1 lastResultN=none", "closure-ext turn=2 lastResultN=1"],
		});
		expect(await runTwoTurns("split-local")).toEqual(fused);
	});
});
