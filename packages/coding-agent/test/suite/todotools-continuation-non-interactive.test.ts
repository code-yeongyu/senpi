import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.js";
import type { TodoItem } from "../../src/core/extensions/builtin/todotools/state.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

const PENDING_TODOS: TodoItem[] = [
	{ content: "Keep the print output single-shot", status: "in_progress", priority: "high" },
	{ content: "Skip follow-up injection outside interactive mode", status: "pending", priority: "medium" },
];

function createIncompleteTodoResponses(): FauxResponseStep[] {
	return [
		fauxAssistantMessage([fauxToolCall("todowrite", { todos: PENDING_TODOS })], { stopReason: "toolUse" }),
		fauxAssistantMessage("saved"),
	];
}

async function createNonInteractiveHarness(): Promise<Harness> {
	const extensionsResult = await createTestExtensionsResult([todotoolsExtension]);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
	});
	await harness.session.bindExtensions({
		shutdownHandler: () => {},
	});
	harnesses.push(harness);
	return harness;
}

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

describe("todotools continuation non-interactive mode", () => {
	it.each(["print mode", "rpc mode"])(
		"does not inject continuation when %s is simulated via ctx.hasUI === false",
		async () => {
			const harness = await createNonInteractiveHarness();
			harness.setResponses(createIncompleteTodoResponses());

			await harness.session.prompt("create incomplete todos and stop");

			expect(harness.getInjectedUserMessages()).toEqual([]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(getUserTexts(harness)).toEqual(["create incomplete todos and stop"]);
			expect(getAssistantTexts(harness)).toContain("saved");
		},
	);
});
