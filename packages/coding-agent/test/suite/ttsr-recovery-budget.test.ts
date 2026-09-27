import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import ttsrExtension from "../../src/core/extensions/builtin/ttsr/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function collapse() {
	return fauxAssistantMessage([fauxThinking(`considering the task ${"!".repeat(600)}`)]);
}

function clean() {
	return fauxAssistantMessage([fauxText("The task completed successfully.")]);
}

function activations(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "rule-activation" ? [entry.data] : []));
}

function nudges(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "ttsr-injection",
	);
}

async function runUntilIdle(harness: Harness, action: () => Promise<void>): Promise<void> {
	// Observe the public boundary after all deferred corrective turns, not just
	// the promise for the initial provider call.
	const idle = Promise.withResolvers<void>();
	const unsubscribe = harness.session.subscribe((event) => {
		if (event.type === "agent_idle") idle.resolve();
	});
	try {
		await action();
		await idle.promise;
	} finally {
		unsubscribe();
	}
}

describe("builtin collapse recovery budget", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			if (harness === undefined) continue;
			await harness.session.abort();
			await harness.session.waitForIdle();
			harness.cleanup();
		}
	});

	async function setup() {
		const harness = await createHarness({ extensionFactories: [ttsrExtension], persistSession: true });
		harnesses.push(harness);
		return harness;
	}

	it("truncates a second consecutive collapse without queuing another automatic turn", async () => {
		const harness = await setup();
		// The clean escape response makes the unfixed reproduction finite.
		harness.setResponses([collapse(), collapse(), collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));

		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(nudges(harness)).toHaveLength(1);
		expect(activations(harness)).toEqual([
			{ kind: "ttsr", owner: "collapse-repetition", rules: ["collapse-repetition"], remediation: "nudge" },
			{ kind: "ttsr", owner: "collapse-repetition", rules: ["collapse-repetition"], remediation: "stopped" },
		]);
		const assistants = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistants).toHaveLength(2);
		for (const message of assistants) {
			expect(message.stopReason).toBe("aborted");
			expect(getMessageText(message)).toContain("[output interrupted by stream rule]");
			expect(JSON.stringify(message.content)).not.toContain("!".repeat(40));
		}
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
	});

	it.each(["interactive", "rpc"] as const)("allows one fresh recovery after genuine %s input", async (source) => {
		const harness = await setup();
		harness.setResponses([collapse(), collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("first task"));
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("try the task again", { source }));

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(nudges(harness)).toHaveLength(2);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("completed successfully");
	});

	it("does not reset the allowance on extension input or an unsuccessful non-collapse response", async () => {
		const harness = await setup();
		harness.setResponses([collapse(), collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));
		harness.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid test input" })]);
		await runUntilIdle(harness, () => harness.session.prompt("automatic continuation", { source: "extension" }));
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () =>
			harness.session.prompt("another automatic continuation", { source: "extension" }),
		);

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(nudges(harness)).toHaveLength(1);
		expect(activations(harness).at(-1)).toMatchObject({ remediation: "stopped" });
	});

	it("re-arms after clean recovery without requiring a new user-input event", async () => {
		const harness = await setup();
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () =>
			harness.session.sendCustomMessage(
				{ customType: "test-work", content: "continue the work", display: false },
				{ triggerTurn: true },
			),
		);

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(nudges(harness)).toHaveLength(2);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("completed successfully");
	});

	it("keeps the collapse allowance exhausted across bounded control-token provider retry", async () => {
		const harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			settings: { retry: { baseDelayMs: 1, maxRetries: 1 } },
		});
		harnesses.push(harness);
		const leaked = ["<", "|", "sep", "|", ">"].join("");
		harness.setResponses([
			collapse(),
			fauxAssistantMessage([fauxThinking(`Thinking... ${leaked} ${leaked} ${leaked} ${leaked} trailing garbage`)]),
			collapse(),
			clean(),
		]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));

		expect(harness.faux.getCallLog()).toHaveLength(3);
		expect(nudges(harness)).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(activations(harness)).toEqual([
			expect.objectContaining({ remediation: "nudge" }),
			expect.objectContaining({ owner: "control-token-leak", remediation: "provider-error" }),
			expect.objectContaining({ owner: "collapse-repetition", remediation: "stopped" }),
		]);
	});

	it("counts a clean tool-use completion as progress between collapse chains", async () => {
		const harness = await createHarness({
			extensionFactories: [ttsrExtension],
			persistSession: true,
			tools: [
				{
					name: "progress",
					label: "Progress",
					description: "Complete a test action",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "Action completed" }], details: {} }),
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			collapse(),
			fauxAssistantMessage([fauxToolCall("progress", {})], { stopReason: "toolUse" }),
			collapse(),
			clean(),
		]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));

		expect(harness.faux.getCallLog()).toHaveLength(4);
		expect(nudges(harness)).toHaveLength(2);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
		expect(getMessageText(harness.session.messages.at(-1))).toContain("completed successfully");
	});

	it("discards an armed correction on user abort and permits later real input", async () => {
		const harness = await setup();
		let abort: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "agent_end" && abort === undefined) abort = harness.session.abort();
		});
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));
		await abort;
		await harness.session.waitForIdle();
		unsubscribe();
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(nudges(harness)).toHaveLength(0);

		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("try again"));
		expect(harness.faux.getCallLog()).toHaveLength(3);
		expect(nudges(harness)).toHaveLength(1);
	});

	it("clears an armed correction and its allowance across a session-start boundary", async () => {
		let harness: Harness;
		let reset = true;
		harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				ttsrExtension,
				(pi) => {
					pi.on("agent_end", async () => {
						if (!reset) return;
						reset = false;
						await harness.getExtensionRunner().emit({ type: "session_start", reason: "new" });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("do the task"));
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(nudges(harness)).toHaveLength(0);

		harness.setResponses([collapse(), clean()]);
		await runUntilIdle(harness, () => harness.session.prompt("new session work", { source: "extension" }));
		expect(harness.faux.getCallLog()).toHaveLength(3);
		expect(nudges(harness)).toHaveLength(1);
	});
});
