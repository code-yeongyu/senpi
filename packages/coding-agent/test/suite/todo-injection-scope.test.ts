import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const TASK_MANAGEMENT_MARKER = "<Task_Management>";

describe("todo task-management injection scope", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("omits task-management doctrine when the todo tool is not active", async () => {
		// given — an allowlist without `todo`, matching a delegated worker profile
		const extensionsResult = await createTestExtensionsResult([todotoolsExtension]);
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			excludedToolNames: ["todo"],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("work");

		// then
		const systemPrompt = harness.faux.getCallLog()[0]?.context.systemPrompt ?? "";
		expect(systemPrompt).not.toContain(TASK_MANAGEMENT_MARKER);
	});

	it("injects task-management doctrine when the todo tool is active", async () => {
		// given
		const extensionsResult = await createTestExtensionsResult([todotoolsExtension]);
		const harness = await createHarness({
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		// when
		await harness.session.prompt("work");

		// then
		const systemPrompt = harness.faux.getCallLog()[0]?.context.systemPrompt ?? "";
		expect(systemPrompt).toContain(TASK_MANAGEMENT_MARKER);
	});
});
