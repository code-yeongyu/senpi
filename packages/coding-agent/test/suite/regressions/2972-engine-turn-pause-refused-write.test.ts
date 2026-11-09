import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, SendMessageItem } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { settlesWithin } from "./issue-3811-resume-support.ts";

async function drain(harness: Harness): Promise<void> {
	for (let pass = 0; pass < 20; pass++) {
		await harness.session.waitForIdle();
		await Promise.resolve();
	}
}

/** A session whose automatic-turn budget after the user's message is spent (senpi#2967). */
async function spentHarness(): Promise<Harness> {
	const harness = await createHarness({ settings: { engineTurns: { maxPerUserInput: 1 } } });
	harness.setResponses([
		fauxAssistantMessage([fauxText("user reply")]),
		fauxAssistantMessage([fauxText("d-1 reply")]),
	]);
	await harness.session.prompt("hello");
	harness.session.externalAdmission.admit({ delivery_id: "d-1", text: "DELIVERY d-1", deliverAs: "followUp" });
	await drain(harness);
	return harness;
}

function stateHas(harness: Harness, marker: string): boolean {
	return JSON.stringify(harness.session.agent.state.messages).includes(marker);
}

/** A spent-budget session bound in RPC mode, with the extension API captured (senpi#2972). */
async function spentItemizedHarness(): Promise<{ harness: Harness; api: () => ExtensionAPI }> {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		settings: { engineTurns: { maxPerUserInput: 1 } },
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	await harness.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	harness.setResponses([
		fauxAssistantMessage([fauxText("user reply")]),
		fauxAssistantMessage([fauxText("d-1 reply")]),
	]);
	await harness.session.prompt("hello");
	harness.session.externalAdmission.admit({ delivery_id: "d-1", text: "DELIVERY d-1", deliverAs: "followUp" });
	await drain(harness);
	return {
		harness,
		api: () => {
			if (api === undefined) throw new Error("extension binding unavailable");
			return api;
		},
	};
}

function fileHas(harness: Harness, marker: string): boolean {
	// A work-custody envelope legitimately quotes the message payload, so it
	// does not count as the message's own transcript entry.
	return harness.session.sessionManager
		.getBranch()
		.filter((entry) => !(entry.type === "custom" && entry.customType === "work-custody"))
		.some((entry) => JSON.stringify(entry).includes(marker));
}

describe("senpi#2972 engine-turn pause: a refused message follows the transcript-failure contract", () => {
	let harness: Harness;

	afterEach(() => {
		harness.cleanup();
	});

	it("case 1: a refused non-delivery message is recorded and leaves the context", async () => {
		// given a session whose budget is spent and whose file refuses the write
		harness = await spentHarness();
		const failures: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "transcript_write_failed") failures.push(event.errorMessage);
		});
		const append = vi.spyOn(harness.session.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});

		// when a non-delivery message hits the pause path
		await harness.session.sendCustomMessage(
			{ customType: "extension-test-notice", content: "NOTICE eval-result", display: false },
			{ triggerTurn: true },
		);
		await drain(harness);
		append.mockRestore();

		// then the failure is recorded and the context matches the file
		expect(failures).toEqual(["EACCES: permission denied"]);
		expect(stateHas(harness, "NOTICE eval-result")).toBe(false);
		expect(fileHas(harness, "NOTICE eval-result")).toBe(false);
	});

	it("case 2: a listener that throws after a successful write does not refuse the delivery", async () => {
		// given a session whose budget is spent and a listener that throws on message_start
		harness = await spentHarness();
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom") throw new Error("listener boom");
		});

		// when another delivery arrives with the budget spent
		const result = harness.session.externalAdmission.admit({
			delivery_id: "d-2",
			text: "DELIVERY d-2",
			deliverAs: "followUp",
		});
		await drain(harness);

		// then it started no turn, but it is persisted, kept in context, and no longer pending
		expect(result.kind).toBe("started");
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(harness.session.externalAdmission.list()).toEqual({ pending: [], emitted: ["d-1", "d-2"] });
		expect(stateHas(harness, "DELIVERY d-2")).toBe(true);
		expect(fileHas(harness, "DELIVERY d-2")).toBe(true);
	});

	it("case 3: a listener that throws on entry_appended after a successful write still settles the delivery", async () => {
		// given a session whose budget is spent, bound in RPC mode, and a listener that throws on entry_appended
		const { harness: itemizedHarness, api } = await spentItemizedHarness();
		harness = itemizedHarness;
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended") throw new Error("listener boom");
		});
		const items: readonly SendMessageItem[] = [{ itemId: "i-1", producer: "task", content: "ITEMIZED d-2 finished" }];

		// when an itemized delivery arrives with the budget spent
		const sending = api().sendMessage(
			{ customType: "omo-senpi:wake", content: "ITEMIZED d-2 finished", display: false },
			{ triggerTurn: true, deliverAs: "followUp", items },
		);

		// then its receipts settle as persisted (never hang), the entry is written, and no turn started
		const receipts = await settlesWithin(Promise.resolve(sending), "the itemized delivery's receipts");
		expect(receipts?.map((receipt) => [receipt.itemId, receipt.disposition])).toEqual([["i-1", "message_persisted"]]);
		await drain(harness);
		expect(harness.faux.getCallLog()).toHaveLength(2);
		expect(stateHas(harness, "ITEMIZED d-2 finished")).toBe(true);
		expect(fileHas(harness, "ITEMIZED d-2 finished")).toBe(true);
	});
});
