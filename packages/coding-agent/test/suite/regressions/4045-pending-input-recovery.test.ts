import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { clientMessageIdentity } from "../../../src/core/client-message-identity.ts";
import { PendingInputAppendUncertainError } from "../../../src/core/pending-input-journal.ts";
import { SessionPendingInputs } from "../../../src/core/pending-input-session.ts";
import { type PendingInputJournal, PendingInputStore } from "../../../src/core/pending-input-store.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";
import { UncertainJournal } from "./4045-pending-input-recovery-support.ts";

// senpi#4045: the actual session queue port must recover without replacing the session or the store.

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function setup(journal: PendingInputJournal) {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }],
		settings: {
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 1,
				fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
			},
		},
	});
	harnesses.push(harness);
	registerFallbackModels(harness, "other-faux", ["faux-2"]);
	let queuedIds = 0;
	const inputs = new SessionPendingInputs({
		sessionManager: harness.sessionManager,
		journal,
		nextQueuedId: () => `q_${++queuedIds}`,
	});
	harness.agent.queuedInputPort = inputs.queuedInputPort();
	const admit = (id: string, text: string) =>
		inputs.admit({ clientMessageId: id, text, mode: "followUp" }, () =>
			harness.agent.followUp({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: 1,
				...clientMessageIdentity({ clientMessageId: id }),
			}),
		);
	return { harness, inputs, admit };
}

describe("senpi#4045: recover uncertain pending input in place", () => {
	it("preserves live handles, revisions, delivery tokens and subscribers during replay", async () => {
		const journal = new UncertainJournal();
		journal.failures = 0;
		let ids = 0;
		const store = await PendingInputStore.open({ journal, lifetimeId: "live", nextQueuedId: () => `q_${++ids}` });
		const submit = {
			clientMessageId: "first",
			fingerprint: "first",
			text: "original",
			attachments: [],
			requestedMode: "followUp",
		} as const;
		await store.submit(submit);
		await store.apply("first", {
			type: "edit",
			effectId: "edit",
			handle: { lifetimeId: "live", queuedId: "q_1" },
			expectedRevision: 1,
			text: "edited",
			attachments: [],
		});
		const token = {
			clientMessageId: "first",
			lifetimeId: "live",
			ownerId: "owner",
			writerGeneration: 1,
			attemptId: "attempt",
		};
		await store.apply("first", { type: "reserve", token });
		const seen: string[] = [];
		store.subscribe((inputs) => seen.push(...inputs.map((input) => input.clientMessageId)));
		journal.failures = 1;
		await expect(store.submit({ ...submit, clientMessageId: "second" })).rejects.toBeInstanceOf(
			PendingInputAppendUncertainError,
		);

		await store.apply("first", { type: "consumed", token });

		expect(store.current("first")).toMatchObject({
			phase: "delivered",
			revision: 2,
			text: "edited",
			handle: { lifetimeId: "live", queuedId: "q_1" },
		});
		expect(seen).toContain("second");
		expect(seen).toContain("first");
		expect(journal.records.map((record) => record.cursor)).toEqual(
			journal.records.map((_record, index) => index + 1),
		);
	});

	it.each([true, false])(
		"the next prompt succeeds and reconciles an uncertain admission (landed=%s)",
		async (landed) => {
			const journal = new UncertainJournal();
			journal.landed = landed;
			const { harness, inputs, admit } = await setup(journal);
			harness.setResponses([fauxAssistantMessage("next"), fauxAssistantMessage("queued input handled")]);
			await expect(admit("uncertain", "keep this input")).rejects.toBeInstanceOf(PendingInputAppendUncertainError);

			await harness.session.prompt("next prompt");

			expect(getUserTexts(harness)).toEqual(landed ? ["next prompt", "keep this input"] : ["next prompt"]);
			const answer = (await inputs.snapshot(["uncertain"])).outcomes[0];
			expect(answer).toMatchObject(
				landed
					? { status: "admitted", projection: { state: "delivered" } }
					: { clientMessageId: "uncertain", status: "not_admitted" },
			);
			expect(harness.session.messages.findLast((message) => message.role === "assistant")?.stopReason).toBe("stop");
			expect(journal.records.map((record) => record.cursor)).toEqual(
				journal.records.map((_record, index) => index + 1),
			);
		},
	);

	it("keeps repeated recovery sync failures local without model fallback", async () => {
		const journal = new UncertainJournal();
		journal.failures = Number.POSITIVE_INFINITY;
		const { harness, admit } = await setup(journal);
		harness.setResponses([fauxAssistantMessage("must not be requested")]);
		await expect(admit("uncertain", "not yet durable")).rejects.toBeInstanceOf(PendingInputAppendUncertainError);

		await harness.session.prompt("first retry");
		await harness.session.prompt("second retry");

		expect(journal.reads).toBeGreaterThanOrEqual(3);
		expect(harness.faux.getCallLog()).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		const failures = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(failures).toHaveLength(2);
		expect(failures.map((message) => message.failureSource)).toEqual(["local", "local"]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it.each(["sending", "delivered", "release"] as const)(
		"keeps custody when the uncertain append is a %s transition",
		async (failPhase) => {
			const journal = new UncertainJournal();
			journal.failures = 0;
			const { harness, inputs, admit } = await setup(journal);
			await admit("queued", "deliver exactly once");
			journal.failPhase = failPhase === "release" ? "queued" : failPhase;
			journal.refuseConsumption = failPhase === "release";
			journal.failures = 1;
			harness.setResponses([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("next answer"),
				fauxAssistantMessage("handled"),
			]);
			await harness.session.prompt("first prompt");

			await harness.session.prompt("next prompt");

			expect(getUserTexts(harness).filter((text) => text === "deliver exactly once")).toHaveLength(1);
			expect((await inputs.snapshot(["queued"])).outcomes).toMatchObject([
				{ status: "admitted", projection: { state: "delivered" } },
			]);
			expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
			expect(journal.records.map((record) => record.cursor)).toEqual(
				journal.records.map((_record, index) => index + 1),
			);
		},
	);

	it.each(["edited", undefined])("finishes a landed native mutation once (text=%s)", async (text) => {
		const journal = new UncertainJournal();
		journal.failures = 0;
		const { harness, inputs, admit } = await setup(journal);
		await admit("queued", "original");
		const message = harness.agent.peekQueuedMessages()[0];
		if (message === undefined) throw new Error("no native input");
		let changes = 0;
		journal.failures = 1;
		await expect(
			inputs.change({ clientMessageId: "queued", text, effectId: "mutation" }, () => {
				changes += 1;
				if (text === undefined) return harness.agent.removeQueuedMessage(message) ? "removed" : "not_found";
				return harness.agent.replaceQueuedMessage(message, {
					role: "user",
					content: text,
					...clientMessageIdentity({ clientMessageId: "queued" }),
					timestamp: 1,
				})
					? "edited"
					: "not_found";
			}),
		).rejects.toBeInstanceOf(PendingInputAppendUncertainError);
		harness.setResponses([fauxAssistantMessage("next"), fauxAssistantMessage("handled")]);

		await inputs.snapshot(["queued"]);
		await harness.session.prompt("next");

		expect(changes).toBe(1);
		expect(getUserTexts(harness)).toEqual(text === undefined ? ["next"] : ["next", text]);
	});

	it("a clear fences an uncertain admission before recovery can enqueue it", async () => {
		const journal = new UncertainJournal();
		const { harness, inputs, admit } = await setup(journal);
		await expect(admit("uncertain", "stopped")).rejects.toBeInstanceOf(PendingInputAppendUncertainError);
		harness.setResponses([fauxAssistantMessage("next")]);

		await inputs.recordCleared([]);
		await harness.session.prompt("next");

		expect(getUserTexts(harness)).toEqual(["next"]);
		expect((await inputs.snapshot(["uncertain"])).outcomes).toMatchObject([
			{ status: "admitted", projection: { state: "removed" } },
		]);
	});
});
