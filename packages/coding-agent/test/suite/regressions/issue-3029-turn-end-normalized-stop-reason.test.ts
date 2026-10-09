import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("turn_end boundary when the loop normalizes a response's stop reason (senpi#3029)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{
			label: "a stop response with a pending tool call",
			response: () => fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "stop" }),
		},
		{
			label: "a toolUse response without a tool call",
			response: () => fauxAssistantMessage("done", { stopReason: "toolUse" }),
		},
	])("Given $label when the turn ends then turn_end handlers get its persisted entry ID", async ({ response }) => {
		// given
		const tool: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		};
		const entryIds: Array<string | undefined> = [];
		const harness = await createHarness({
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						entryIds.push(event.messageEntryId);
					});
				},
			],
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		harness.getExtensionRunner().onError((error) => errors.push(error));
		harness.setResponses([response(), fauxAssistantMessage("finished")]);

		// when
		await harness.session.prompt("go");

		// then
		expect(errors.filter((error) => error.extensionPath === "<boundary>")).toEqual([]);
		expect(entryIds.length).toBeGreaterThan(0);
		for (const id of entryIds) {
			const entry = id === undefined ? undefined : harness.sessionManager.getEntry(id);
			expect(entry?.type === "message" ? entry.message.role : undefined).toBe("assistant");
		}
	});
});
