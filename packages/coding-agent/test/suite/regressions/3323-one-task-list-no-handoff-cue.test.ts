import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import { HANDOFF_CUES } from "../../../src/core/extensions/builtin/todotools/state.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// senpi#3323: the first-turn opener turns a question that does not end in `?` ("explain this code")
// into a one-task todo list, and the todo result then demanded the handoff block, so a plain
// answer came back wrapped in Ask / For you / Now / Next. A one-task list is no multi-step work.

const harnesses: Harness[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function todoResults(calls: Array<Parameters<typeof fauxToolCall>[1]>): Promise<string[]> {
	const harness = await createHarness({ extensionFactories: [todotoolsExtension] });
	harnesses.push(harness);
	harness.setResponses([
		...calls.map((args) => fauxAssistantMessage([fauxToolCall("todo", args)], { stopReason: "toolUse" })),
		fauxAssistantMessage("answer"),
	]);
	await harness.session.prompt("explain what this function does");
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "todo" ? [getMessageText(message)] : [],
	);
}

describe("senpi#3323 a one-task todo list asks for no handoff block", () => {
	it("creating and closing a one-task list carries no handoff cue", async () => {
		// given: the terminal surface, where the first-turn opener runs
		vi.stubEnv("SENPI_PROMPT_SURFACE", "terminal");

		// when: the model plans the question as one task and closes it
		const texts = await todoResults([
			{ op: "init", items: ["Answer what the function does"] },
			{ op: "done", task: "Answer what the function does" },
		]);

		// then: both results report the list, and neither asks for the block
		expect(texts).toHaveLength(2);
		for (const text of texts) expect(text).not.toContain("Handoff due");
	});

	it("a two-task list still gets the list-created and all-closed cues", async () => {
		// given
		vi.stubEnv("SENPI_PROMPT_SURFACE", "terminal");

		// when
		const texts = await todoResults([
			{ op: "init", items: ["Read the function", "Explain it"] },
			{ op: "done", task: "Read the function" },
			{ op: "done", task: "Explain it" },
		]);

		// then
		expect(texts[0]?.endsWith(HANDOFF_CUES["list-created"])).toBe(true);
		expect(texts[2]?.endsWith(HANDOFF_CUES["all-closed"])).toBe(true);
	});
});
