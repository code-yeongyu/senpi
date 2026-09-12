import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("RPC command invocation events", () => {
	it("emits one event after an extension command actually runs", async () => {
		let handledArgs = "";
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("hooks", {
						description: "Manage hooks",
						handler: async (args) => {
							handledArgs = args;
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/hooks list");

		expect(handledArgs).toBe("list");
		expect(harness.eventsOfType("command_invocation")).toEqual([
			{
				type: "command_invocation",
				command: expect.objectContaining({
					name: "hooks",
					source: "extension",
					syntax: "slash",
				}),
			},
		]);
	});

	it("emits one event after a prompt template survives input interception", async () => {
		const sourceInfo = createSyntheticSourceInfo("review.md", { source: "test" });
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({
				prompts: [
					{
						name: "review",
						description: "Review work",
						content: "Review this carefully.",
						sourceInfo,
						filePath: "/tmp/review.md",
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.setResponses([() => fauxAssistantMessage("done")]);

		await harness.session.prompt("/review");

		expect(harness.eventsOfType("command_invocation")).toEqual([
			{
				type: "command_invocation",
				command: { name: "review", source: "prompt", sourceInfo, syntax: "slash" },
			},
		]);
	});

	it("does not emit when an input handler transforms the apparent command", async () => {
		const sourceInfo = createSyntheticSourceInfo("review.md", { source: "test" });
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("input", (event) => {
					if (event.text === "/review") return { action: "transform", text: "ordinary text" };
				});
			},
		]);
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult }),
			getPrompts: () => ({
				prompts: [
					{
						name: "review",
						description: "Review work",
						content: "Review this carefully.",
						sourceInfo,
						filePath: "/tmp/review.md",
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		harness.setResponses([() => fauxAssistantMessage("done")]);

		await harness.session.prompt("/review");

		expect(getUserTexts(harness).at(-1)).toBe("ordinary text");
		expect(harness.eventsOfType("command_invocation")).toEqual([]);
	});

	it("does not emit for unknown commands or ordinary dollar text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([() => fauxAssistantMessage("done"), () => fauxAssistantMessage("done")]);

		await harness.session.prompt("/unknown");
		await harness.session.prompt("$HOME is literal");

		expect(harness.eventsOfType("command_invocation")).toEqual([]);
	});
});
