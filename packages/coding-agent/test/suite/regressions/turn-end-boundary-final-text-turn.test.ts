import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * The turn_end boundary runs from the agent's finishTurn hook, before the agent emits turn_end.
 * AgentSession persists message_end on its own asynchronous event queue, so the boundary must
 * wait for that queue to persist the turn's messages before resolving their entry IDs. A
 * text-only final turn reaches finishTurn right after message_end, so an async message_end
 * handler (as the CLI builtins have) is still in flight there. The test holds the final
 * assistant's message_end handler until the session's finishTurn hook has started.
 */
interface ObservedTurnEnd {
	turnIndex: number;
	stopReason: string | undefined;
	messageEntryId: string;
	toolResultEntryIds: string[];
}

function persistedMessageEntryIds(harness: Harness, role: "assistant" | "toolResult"): string[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === role)
		.map((entry) => entry.id);
}

async function createObservedHarness(tools: AgentTool[] = []) {
	const observed: ObservedTurnEnd[] = [];
	let reachFinalFinishTurn = () => {};
	const finalFinishTurnReached = new Promise<void>((resolve) => {
		reachFinalFinishTurn = resolve;
	});
	const harness = await createHarness({
		tools,
		extensionFactories: [
			(pi) => {
				pi.on("message_end", async (event) => {
					if ("stopReason" in event.message && event.message.stopReason === "stop") {
						await finalFinishTurnReached;
					}
				});
				pi.on("turn_end", (event) => {
					observed.push({
						turnIndex: event.turnIndex,
						stopReason: "stopReason" in event.message ? event.message.stopReason : undefined,
						messageEntryId: event.messageEntryId,
						toolResultEntryIds: [...event.toolResultEntryIds],
					});
				});
			},
		],
	});
	const sessionFinishTurn = harness.agent.finishTurn;
	harness.agent.finishTurn = (turn, signal) => {
		const decision = sessionFinishTurn?.(turn, signal);
		if (turn.message.stopReason === "stop") reachFinalFinishTurn();
		return decision;
	};
	const errors: ExtensionError[] = [];
	harness.getExtensionRunner().onError((error) => errors.push(error));
	return { harness, observed, errors };
}

describe("turn_end boundary on a text-only final turn", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers turn_end with the persisted assistant entry ID for a single text-only turn", async () => {
		const { harness, observed, errors } = await createObservedHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("only answer")]);

		await harness.session.prompt("hello");

		expect(errors.filter((error) => error.extensionPath === "<boundary>")).toEqual([]);
		const [assistantEntryId] = persistedMessageEntryIds(harness, "assistant");
		expect(observed).toEqual([
			{ turnIndex: 0, stopReason: "stop", messageEntryId: assistantEntryId, toolResultEntryIds: [] },
		]);
	});

	it("delivers turn_end once per turn when a tool turn is followed by a text-only final turn", async () => {
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const { harness, observed, errors } = await createObservedHarness([tool]);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("run the tool");

		expect(errors.filter((error) => error.extensionPath === "<boundary>")).toEqual([]);
		const assistantEntryIds = persistedMessageEntryIds(harness, "assistant");
		const toolResultEntryIds = persistedMessageEntryIds(harness, "toolResult");
		expect(assistantEntryIds).toHaveLength(2);
		expect(toolResultEntryIds).toHaveLength(1);
		expect(observed).toEqual([
			{
				turnIndex: 0,
				stopReason: "toolUse",
				messageEntryId: assistantEntryIds[0],
				toolResultEntryIds,
			},
			{ turnIndex: 1, stopReason: "stop", messageEntryId: assistantEntryIds[1], toolResultEntryIds: [] },
		]);
	});
});
