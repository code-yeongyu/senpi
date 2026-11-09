import { type AgentTool, isStepCommitError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHostedHarness, type HostedHarness } from "./index.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Returns its input.",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return { content: [{ type: "text", text }], details: {} };
	},
};

describe("CK22 hosted harness over a real AgentSession", () => {
	let harness: HostedHarness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("commits every step of a real agent loop turn, in order, through the commit hook", async () => {
		harness = await createHostedHarness({ tools: [echoTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);

		await harness.session.prompt("go");

		expect(harness.commits.map((commit) => commit.message.stopReason)).toEqual(["toolUse", "stop"]);
		expect(harness.commits.every((commit) => commit.outcome === "committed")).toBe(true);
		expect(harness.counters.providerCalls).toBe(2);
		expect(harness.counters.events).toBe(harness.events.length);
	});

	it("rejects an injected commit with the branded StepCommitError and records it", async () => {
		harness = await createHostedHarness();
		harness.setResponses([fauxAssistantMessage([fauxText("one")])]);
		harness.inject.nextCommit("reject");

		await harness.session.prompt("go").catch(() => undefined);

		expect(harness.commits).toHaveLength(1);
		expect(harness.commits[0]?.outcome).toBe("rejected");
		expect(isStepCommitError(harness.commits[0]?.error)).toBe(true);
	});

	it("holds an injected never-settling commit until the test releases it", async () => {
		harness = await createHostedHarness();
		harness.setResponses([fauxAssistantMessage([fauxText("one")])]);
		const held = harness.inject.nextCommit("hold");

		const prompt = harness.session.prompt("go");
		await held.reached;
		expect(harness.commits.map((commit) => commit.outcome)).toEqual(["pending"]);

		held.release();
		await prompt;
		expect(harness.commits.map((commit) => commit.outcome)).toEqual(["committed"]);
	});
});
