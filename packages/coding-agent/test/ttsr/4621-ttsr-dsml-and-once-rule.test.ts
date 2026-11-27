import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it } from "vitest";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, getMessageText, type Harness } from "../suite/harness.ts";
import { expectTtsrActivation } from "../suite/ttsr-activation-assertions.ts";

let harness: Harness;

beforeEach(async () => {
	harness = await createHarness({
		extensionFactories: [ttsrExtension],
		persistSession: true,
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
	});
	await harness.session.bindExtensions({ mode: "rpc" });
});

afterEach(() => harness.cleanup());

async function promptToIdle(input: string): Promise<void> {
	const { session } = harness;
	let unsubscribe = () => {};
	const idle = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error("agent_idle was not emitted"));
		}, 10_000);
		unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_idle") return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		});
	});
	await Promise.all([session.prompt(input), idle]);
}

// senpi#4621: reconstruct the reported DSML invoke envelope and its repeated imitation in thinking.
const dsmlInvoke = '<｜DSML｜invoke name="read">file</｜DSML｜invoke>\n';

it("resamples instead of nudging when a DeepSeek thinking stream repeats DSML", async () => {
	harness.setResponses([
		fauxAssistantMessage([fauxThinking(`Thinking...\n${dsmlInvoke.repeat(16)}`)]),
		fauxAssistantMessage("recovered answer"),
	]);

	await promptToIdle("read the file");

	const entries = harness.sessionManager.getEntries();
	expectTtsrActivation(entries, {
		owner: "control-token-leak",
		rules: ["control-token-leak"],
		remediation: "provider-error",
	});
	expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
	expect(entries.filter((entry) => entry.type === "custom_message" && entry.customType === "ttsr-injection")).toEqual(
		[],
	);
	const firstAssistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
	expect(firstAssistant).toMatchObject({ message: { stopReason: "error", content: [] } });
	expect(getMessageText(harness.session.messages.at(-1))).toBe("recovered answer");
});

it("leaves a quoted DSML example alone", async () => {
	harness.setResponses([fauxAssistantMessage(`\`\`\`xml\n${dsmlInvoke}\`\`\``)]);

	await promptToIdle("show the markup");

	expect(harness.faux.getCallLog()).toHaveLength(1);
	expect(getMessageText(harness.session.messages.at(-1))).toContain(dsmlInvoke.trim());
});

// senpi#4621: a repeat stops the current run, but it must not spend later user-directed turns' budgets.
it("allows one collapse correction per user turn, including consecutive manual continues", async () => {
	const collapse = fauxAssistantMessage([fauxThinking(`Checking the result ${"!".repeat(600)}`)]);
	const stops = () =>
		harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "ttsr-loop-stopped");

	harness.setResponses([collapse, collapse]);
	await promptToIdle("start work");
	expect(harness.faux.getCallLog()).toHaveLength(2);
	expect(stops()).toHaveLength(1);

	for (const [index, input] of [".", ".", "continue the work"].entries()) {
		harness.setResponses([collapse, fauxAssistantMessage(`recovered turn ${index + 1}`)]);
		await promptToIdle(input);

		expect(harness.faux.getCallLog()).toHaveLength(4 + index * 2);
		expect(stops()).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toBe(`recovered turn ${index + 1}`);
	}
});
