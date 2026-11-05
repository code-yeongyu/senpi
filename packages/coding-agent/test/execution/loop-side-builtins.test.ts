// S32 (senpi#5641): web search, web fetch and the ask-user tools are loop-side (Q's 2026-11-03 split; the issue names
// ask_user a session tool). A split session runs each on the brain and never on the hand; a fused session is unchanged.
import {
	createLoopToolHost,
	createSplitToolHost,
	loopSideToolNames,
	type ToolHost,
} from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import webfetchExtension from "../../src/core/extensions/builtin/webfetch/index.ts";
import websearchExtension from "../../src/core/extensions/builtin/websearch/index.ts";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { createHarness, createTestUiContext, type Harness } from "../suite/harness.ts";
import { call, recordingHost } from "./session-plane-fixture.ts";

const LOOP_SIDE = ["web_search", "webfetch", "request_user_input", "ask_user_question"];

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function builtinsHarness(): Promise<Harness> {
	const harness = await createHarness({
		extensionFactories: [websearchExtension, webfetchExtension, askUserExtension],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
	return harness;
}

function definitionsOf(harness: Harness): ToolDefinition[] {
	return harness.session.getAllTools().flatMap((tool) => harness.session.getToolDefinition(tool.name) ?? []);
}

async function webfetchTurn(split: boolean): Promise<{ readonly results: unknown[]; readonly onHand: string[] }> {
	const harness = await builtinsHarness();
	const onHand: string[] = [];
	if (split) {
		const loopSide = loopSideToolNames(definitionsOf(harness));
		const hand: ToolHost = recordingHost("hand", onHand);
		harness.agent.toolHost = createSplitToolHost({
			loopSide: (name) => loopSide.has(name),
			loop: createLoopToolHost(harness.agent),
			hand,
		});
	}
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("webfetch", { url: "not-a-url" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("fetch it");
	const results = harness.session.messages.flatMap((message) =>
		message.role === "toolResult" ? [{ content: message.content, isError: message.isError }] : [],
	);
	return { results, onHand };
}

describe("loop-side built-ins on a split session (S32)", () => {
	it("declares web_search, webfetch and both ask-user tools loop-side", async () => {
		const definitions = definitionsOf(await builtinsHarness());

		for (const name of LOOP_SIDE)
			expect(definitions.find((definition) => definition.name === name)?.runs, name).toBe("brain");
	});

	it("runs each of them on the brain and none on the hand", async () => {
		const loopSide = loopSideToolNames(definitionsOf(await builtinsHarness()));
		const ran: string[] = [];
		const host = createSplitToolHost({
			loopSide: (name) => loopSide.has(name),
			loop: recordingHost("loop", ran),
			hand: recordingHost("hand", ran),
		});

		await host.execute(
			{
				scope: { id: "s32-builtins", root: "/work" },
				calls: LOOP_SIDE.map((name, index) => call(`b${index}`, name)),
				mode: "parallel",
			},
			{ emit: () => {} },
		);

		expect(ran).toEqual(LOOP_SIDE.map((name) => `loop:${name}`));
	});

	it("gives a split session's webfetch call the fused session's result, run in the loop's process", async () => {
		const fused = await webfetchTurn(false);
		const split = await webfetchTurn(true);

		expect(fused.results).toHaveLength(1);
		expect(split.onHand).toEqual([]);
		expect(split.results).toEqual(fused.results);
	});
});
