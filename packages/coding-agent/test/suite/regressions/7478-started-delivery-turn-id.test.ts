import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#7478 (omo#15013): an external message admitted to an idle session starts a turn, but the reply named the turn
// BEFORE it: the start was not awaited, so the epoch was read before the started run raised it. An agent that steered or
// interrupted with the turn id its own delivery was answered was refused with turn_conflict or acted on no turn.

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function harness(): Promise<Harness> {
	const created = await createHarness({ persistSession: true });
	harnesses.push(created);
	return created;
}

function nextEvent(target: Harness, type: string): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== type) return;
			unsubscribe();
			resolve();
		});
	});
}

function epochAtNextStart(target: Harness): Promise<number> {
	return new Promise((resolve) => {
		const unsubscribe = target.session.subscribe((event) => {
			if (event.type !== "agent_start") return;
			unsubscribe();
			resolve(target.session.externalAdmission.turnEpoch);
		});
	});
}

describe("an external message that starts a turn is answered with that turn (senpi#7478)", () => {
	it("names the turn the admitted message runs in, not the one before it", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const runEpoch = epochAtNextStart(target);
		const idle = nextEvent(target, "agent_idle");

		const answer = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });

		expect(answer.kind).toBe("started");
		expect(answer.turn_epoch).toBe(await runEpoch);
		await idle;
	});

	it("accepts a steer that names the answered turn while that start is still pending", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const idle = nextEvent(target, "agent_idle");

		const started = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });
		const steer = admission.admit({
			delivery_id: "s-1",
			text: "and this",
			deliverAs: "steer",
			expected_turn_id: started.turn_epoch,
		});

		expect(steer).toEqual({ kind: "steered", turn_epoch: started.turn_epoch });
		await idle;
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-1", "s-1"] });
	});

	it("answers a delivery that joins the pending start with the same turn", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("ack")]);
		const admission = target.session.externalAdmission;
		const runEpoch = epochAtNextStart(target);
		const idle = nextEvent(target, "agent_idle");

		const started = admission.admit({ delivery_id: "d-1", text: "hello", deliverAs: "followUp" });
		const joined = admission.admit({ delivery_id: "d-2", text: "me too", deliverAs: "followUp" });

		expect(joined).toEqual({ kind: "steered", turn_epoch: started.turn_epoch });
		expect(joined.turn_epoch).toBe(await runEpoch);
		await idle;
	});

	it("runs a joiner in the turn it was answered with when a person's Stop cuts the start before its run begins", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")]);
		const admission = target.session.externalAdmission;
		const deliveredIn = new Map<string, number>();
		const runEpochs: number[] = [];
		target.session.subscribe((event) => {
			if (event.type === "agent_start") runEpochs.push(admission.turnEpoch);
			if (event.type === "message_start" && event.message.role === "custom") {
				const id = (event.message as { details?: { delivery_id?: string } }).details?.delivery_id;
				if (id !== undefined) deliveredIn.set(id, admission.turnEpoch);
			}
		});

		const started = admission.admit({ delivery_id: "d-1", text: "one", deliverAs: "followUp" });
		const joined = admission.admit({ delivery_id: "d-2", text: "two", deliverAs: "followUp" });
		await target.session.abort();
		expect(admission.turnEpoch).toBe(0);
		const idle = nextEvent(target, "agent_idle");
		await target.session.prompt("next");
		await idle;

		expect(started).toEqual({ kind: "started", turn_epoch: 1 });
		expect(joined).toEqual({ kind: "steered", turn_epoch: 1 });
		expect(deliveredIn.get("d-2")).toBe(1);
		// A Stop this early cancels the engine run the started delivery asked for: it is not run and stays pending
		// with no carrier and no held report, which senpi#7484 tracks.
		expect(deliveredIn.has("d-1")).toBe(false);
		expect(admission.list().pending).toEqual(["d-1"]);
		expect(new Set(runEpochs).size).toBe(runEpochs.length);
	});

	it("names the run that failed when the started run begins and its request fails", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" })]);
		const admission = target.session.externalAdmission;
		const runEpoch = epochAtNextStart(target);
		const idle = nextEvent(target, "agent_idle");

		const started = admission.admit({ delivery_id: "d-1", text: "one", deliverAs: "followUp" });

		expect(started.turn_epoch).toBe(await runEpoch);
		await idle;
		expect(admission.turnEpoch).toBe(started.turn_epoch);
	});

	it("runs a started delivery once in the next run when a person's Stop cuts it during turn admission", async () => {
		const stopDuringAdmission: ExtensionFactory = (pi) => {
			let stopped = false;
			pi.on("before_agent_start", (event, ctx) => {
				if (event.trigger !== "delivery" || stopped) return;
				stopped = true;
				ctx.abort("user");
			});
		};
		const target = await createHarness({ persistSession: true, extensionFactories: [stopDuringAdmission] });
		harnesses.push(target);
		target.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const admission = target.session.externalAdmission;
		const deliveredIn: number[] = [];
		target.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom") deliveredIn.push(admission.turnEpoch);
		});

		const started = admission.admit({ delivery_id: "d-1", text: "one", deliverAs: "followUp" });
		await target.session.waitForIdle();
		const idle = nextEvent(target, "agent_idle");
		await target.session.prompt("next");
		await idle;

		expect(started).toEqual({ kind: "started", turn_epoch: 1 });
		expect(deliveredIn).toHaveLength(1);
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-1"] });
	});

	it("runs a started delivery whose start fails before its run begins once, in the turn it was answered with", async () => {
		const target = await harness();
		target.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const admission = target.session.externalAdmission;
		const deliveredIn = new Map<string, number>();
		target.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "custom") {
				const id = (event.message as { details?: { delivery_id?: string } }).details?.delivery_id;
				if (id !== undefined) deliveredIn.set(id, admission.turnEpoch);
			}
		});
		const failed = Promise.withResolvers<void>();
		const persist = target.sessionManager.persistHeaderNow.bind(target.sessionManager);
		let first = true;
		target.sessionManager.persistHeaderNow = async () => {
			if (!first) return persist();
			first = false;
			failed.resolve();
			throw new Error("disk full");
		};

		const started = admission.admit({ delivery_id: "d-1", text: "one", deliverAs: "followUp" });
		await failed.promise;
		await target.session.waitForIdle();
		const idle = nextEvent(target, "agent_idle");
		await target.session.prompt("next");
		await idle;

		expect(started).toEqual({ kind: "started", turn_epoch: 1 });
		// The failed start's delivery rides the next run, the turn it was answered with, once.
		expect(deliveredIn.get("d-1")).toBe(1);
		expect(target.session.messages.filter((message) => message.role === "custom")).toHaveLength(1);
		expect(admission.list()).toEqual({ pending: [], emitted: ["d-1"] });
	});
});
