import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseRuleActivationDetails } from "../../../src/core/extensions/builtin/rule-activation/types.ts";
import ttsrExtension from "../../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function agentIdle(harness: Harness): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("agent_idle was not emitted"));
		}, 10_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
}

function customEntries(harness: Harness, customType: string) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType);
}

const RUN = "!".repeat(600);

// A reply degenerates into a run of one character; the first hit is nudged and the next reply degenerates again.
describe("collapse-repetition hit pair (a second hit in one turn stops the run)", () => {
	it.each([
		["text", (prefix: string) => fauxAssistantMessage(`${prefix} ${RUN}`)],
		["thinking", (prefix: string) => fauxAssistantMessage([fauxThinking(`${prefix} ${RUN}`), fauxText("done")])],
	] as const)("records which mechanism fired for a %s hit, both times", async (stream, reply) => {
		const harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "rpc" });
		harness.setResponses([reply("first"), reply("second"), fauxAssistantMessage("never requested")]);

		const idle = agentIdle(harness);
		await harness.session.prompt("work");
		await idle;

		// The documented bound: one correction, then the run stops and waits for a person.
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(customEntries(harness, "ttsr-loop-stopped")).toHaveLength(1);
		expect(customEntries(harness, "engine-paused")).toHaveLength(1);

		// Each hit says what fired, so a runaway loop can be told from a false positive afterwards.
		const activations = customEntries(harness, "rule-activation").map((entry) =>
			parseRuleActivationDetails(entry.type === "custom" ? entry.data : undefined),
		);
		expect(activations).toHaveLength(2);
		for (const activation of activations) {
			expect(activation).toMatchObject({
				kind: "ttsr",
				owner: "collapse-repetition",
				remediation: "nudge",
				stream,
				reason: expect.stringMatching(/\S/),
				detail: { mechanism: "dominant-scalar-run", count: expect.any(Number), threshold: expect.any(Number) },
			});
		}
	});
});

// Storage contract: sessions written before reason/detail existed still parse, and a malformed optional field
// never invalidates the activation that carries it (it drives which rules restore as already injected).
describe("rule-activation ttsr entries", () => {
	const base = { kind: "ttsr", owner: "collapse-repetition", rules: ["collapse-repetition"], remediation: "nudge" };

	it("parses an entry without the optional fields and drops malformed ones", () => {
		expect(parseRuleActivationDetails(base)).toEqual(base);
		expect(
			parseRuleActivationDetails({ ...base, stream: "audio", reason: "", detail: { nested: { a: 1 } } }),
		).toEqual(base);
		expect(
			parseRuleActivationDetails({ ...base, reason: "r", detail: { count: 3, sample: "x", flag: true } }),
		).toEqual({
			...base,
			reason: "r",
			detail: { count: 3, sample: "x", flag: true },
		});
	});
});
