import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const BURST = 40 as const;

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function busySession(): Promise<{
	harness: Harness;
	api: ExtensionAPI;
	release: () => void;
	promptDone: Promise<void>;
	requests: TranscriptContext[];
}> {
	let release: (() => void) | undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		tools: [waitTool],
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	harnesses.push(harness);
	const requests: TranscriptContext[] = [];
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		...Array.from({ length: BURST + 4 }, () => (context: TranscriptContext) => {
			requests.push(context);
			return fauxAssistantMessage("noted");
		}),
	]);
	const toolStarted = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	const promptDone = harness.session.prompt("start");
	await toolStarted;
	if (!api) throw new Error("extension API was not captured");
	return { harness, api, release: () => release?.(), promptDone, requests };
}

function notice(api: ExtensionAPI, index: number): void {
	api.sendMessage(
		{ customType: "monitor-event", content: `CI check ${index} finished`, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function noticesIn(context: TranscriptContext): string[] {
	return context.messages.map(getMessageText).filter((text) => /^CI check \d+ finished$/.test(text));
}

describe("a burst of background events while the agent works", () => {
	it("is answered by one turn that sees every event", async () => {
		// Given: the agent is in the middle of a tool call
		const { harness, api, release, promptDone, requests } = await busySession();

		// When: 40 monitor events arrive before the tool finishes
		for (let index = 0; index < BURST; index++) notice(api, index);
		release();
		await promptDone;
		await harness.session.waitForIdle?.();

		// Then: one follow-up turn carried all 40 events instead of 40 separate turns
		const continuation = requests.slice(1);
		expect(continuation).toHaveLength(1);
		expect(noticesIn(continuation[0]!)).toEqual(
			Array.from({ length: BURST }, (_, index) => `CI check ${index} finished`),
		);
	});

	it("still gives each typed follow-up its own turn", async () => {
		// Given: the agent is in the middle of a tool call
		const { harness, release, promptDone, requests } = await busySession();

		// When: the user queues two follow-ups
		await harness.session.followUp("first follow-up");
		await harness.session.followUp("second follow-up");
		release();
		await promptDone;
		await harness.session.waitForIdle?.();

		// Then: the follow-ups were answered one at a time, in order
		const userTurns = requests.slice(1).map((context) =>
			context.messages
				.filter((m) => m.role === "user")
				.map(getMessageText)
				.at(-1),
		);
		expect(userTurns).toEqual(["first follow-up", "second follow-up"]);
	});

	it("keeps a typed follow-up separate from events queued around it", async () => {
		// Given: the agent is in the middle of a tool call
		const { harness, api, release, promptDone, requests } = await busySession();

		// When: events, then a typed follow-up, then more events are queued
		notice(api, 1);
		notice(api, 2);
		await harness.session.followUp("typed in between");
		notice(api, 3);
		release();
		await promptDone;
		await harness.session.waitForIdle?.();

		// Then: each turn carries only what was queued for it, in order: both events, the typed text, the last event
		const turns = requests.slice(1);
		const added = turns.map((context, index) => {
			const previous = index === 0 ? requests[0]! : turns[index - 1]!;
			return context.messages
				.slice(previous.messages.length)
				.map(getMessageText)
				.filter((text) => text !== "noted");
		});
		expect(added).toEqual([
			["CI check 1 finished", "CI check 2 finished"],
			["typed in between"],
			["CI check 3 finished"],
		]);
	});
});
