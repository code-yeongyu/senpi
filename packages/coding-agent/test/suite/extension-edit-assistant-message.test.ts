import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandContextActions } from "../../src/core/extensions/types.ts";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function isAssistantEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "assistant";
}

const unusedAction = async () => ({ cancelled: true });

describe("pi.editAssistantMessage (extension API)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createBoundHarness(): Promise<{
		harness: Harness;
		calls: Array<{ entryId: string; text: string; expectedLeafId?: string }>;
	}> {
		const calls: Array<{ entryId: string; text: string; expectedLeafId?: string }> = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("edit-first-answer", {
						description: "edit the first assistant response",
						handler: async (args, ctx) => {
							const [entryId, text, expectedLeafId] = args.split("|");
							await ctx.editAssistantMessage(entryId, text, { expectedLeafId: expectedLeafId || undefined });
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const actions: ExtensionCommandContextActions = {
			waitForIdle: async () => {},
			newSession: unusedAction,
			fork: unusedAction,
			navigateTree: unusedAction,
			editUserMessage: unusedAction,
			switchSession: unusedAction,
			reload: async () => {},
			editAssistantMessage: async (entryId, text, options) => {
				calls.push({ entryId, text, expectedLeafId: options?.expectedLeafId });
				const result = await harness.session.editAssistantMessage(entryId, text, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					expectedLeafId: options?.expectedLeafId,
				});
				return { cancelled: result.cancelled, unchanged: result.unchanged, entryId: result.entryId };
			},
		};
		await harness.session.bindExtensions({ commandContextActions: actions });
		harness.setResponses([fauxAssistantMessage("The answer is 41.")]);
		await harness.session.prompt("What is the answer?");
		return { harness, calls };
	}

	it("routes an extension command through the bound editAssistantMessage action", async () => {
		const { harness, calls } = await createBoundHarness();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		if (!a1) throw new Error("expected an assistant entry");
		const leaf = harness.sessionManager.getLeafId();

		await harness.session.prompt(`/edit-first-answer ${a1.id}|The answer is 42.|${leaf}`);

		expect(calls).toEqual([{ entryId: a1.id, text: "The answer is 42.", expectedLeafId: leaf }]);
		const texts = harness.sessionManager
			.getEntries()
			.filter(isAssistantEntry)
			.map((e) => getMessageText(e.message));
		expect(texts).toContain("The answer is 42.");
		expect(texts).toContain("The answer is 41.");
		const leafEntry = harness.sessionManager.getEntry(harness.sessionManager.getLeafId() ?? "");
		if (!leafEntry || !isAssistantEntry(leafEntry)) throw new Error("leaf should be the edited assistant entry");
		expect(getMessageText(leafEntry.message)).toBe("The answer is 42.");
		expect(harness.session.lifecycle).toMatchObject({ humanInputRevision: 2, persisted: true });
		// A command that starts no run writes no lifecycle record; its revision waits for the next epoch's opening.
		const admission = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
			.at(-1);
		expect(admission).toMatchObject({ data: { humanInputRevision: 1 } });
	});

	it("refuses a captured leaf when ordinary custom work follows it", async () => {
		const { harness } = await createBoundHarness();
		const [a1] = harness.sessionManager.getEntries().filter(isAssistantEntry);
		const expectedLeafId = harness.sessionManager.getLeafId();
		if (!a1 || !expectedLeafId) throw new Error("expected an assistant entry and leaf");
		harness.sessionManager.appendCustomEntry("extension-note", { value: 1 });
		harness.sessionManager.appendCustomEntry("session-lifecycle", { seq: 100 });

		await expect(
			harness.session.editAssistantMessage(a1.id, "The answer is 42.", { expectedLeafId }),
		).rejects.toMatchObject({ code: "stale_leaf" });
	});
});
