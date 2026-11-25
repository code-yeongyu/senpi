/**
 * omo#14972: a delivery that asks to reach the live turn (`whenBusy: "steer"`) and finds a run already going is steered
 * into that run, decided here where the run state lives, instead of waiting in the follow-up queue for a second run. A
 * caller that does not ask keeps the follow-up behaviour.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const PROBE = /BUSY-PROBE-\d/g;

async function runningSession(admitDuringFirstRequest: (harness: Harness) => void) {
	const harness = await createHarness({ settings: { retry: { enabled: false } } });
	harnesses.push(harness);
	const requests: string[][] = [];
	let runs = 0;
	harness.session.subscribe((event) => {
		if (event.type === "agent_start") runs += 1;
	});
	const record = (context: { readonly messages: readonly unknown[] }) => {
		const tail: unknown[] = [];
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index] as { readonly role?: string };
			if (message.role === "assistant") break;
			tail.unshift(message);
		}
		requests.push(tail.flatMap((message) => getMessageText(message).match(PROBE) ?? []));
		if (requests.length === 1) admitDuringFirstRequest(harness);
		return fauxAssistantMessage(`ack ${requests.length}`);
	};
	harness.setResponses([record, record, record]);
	harness.session.externalAdmission.admit({ delivery_id: "d-0", text: "BUSY-PROBE-0", deliverAs: "followUp" });
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
	return { requests, runs: () => runs, harness };
}

describe("a delivery that asks to reach the live turn (omo#14972)", () => {
	it("is steered into the running run, in the same run, not queued as a follow-up", async () => {
		const kinds: string[] = [];
		const { requests, runs, harness } = await runningSession((h) => {
			for (const n of [1, 2]) {
				const result = h.session.externalAdmission.admit({
					delivery_id: `d-${n}`,
					text: `BUSY-PROBE-${n}`,
					deliverAs: "followUp",
					whenBusy: "steer",
				});
				kinds.push(result.kind);
			}
		});

		expect(kinds).toEqual(["steered", "steered"]);
		expect(requests).toEqual([["BUSY-PROBE-0"], ["BUSY-PROBE-1", "BUSY-PROBE-2"]]);
		expect(runs()).toBe(1);
		expect(harness.session.externalAdmission.list().pending).toEqual([]);
	});

	it("keeps a follow-up that does not ask behind the steering queue, so it costs its own request, as before", async () => {
		const kinds: string[] = [];
		const { requests } = await runningSession((h) => {
			kinds.push(
				h.session.externalAdmission.admit({
					delivery_id: "d-1",
					text: "BUSY-PROBE-1",
					deliverAs: "followUp",
					whenBusy: "steer",
				}).kind,
			);
			kinds.push(
				h.session.externalAdmission.admit({ delivery_id: "d-2", text: "BUSY-PROBE-2", deliverAs: "followUp" }).kind,
			);
		});

		expect(kinds).toEqual(["steered", "queued"]);
		expect(requests).toEqual([["BUSY-PROBE-0"], ["BUSY-PROBE-1"], ["BUSY-PROBE-2"]]);
	});
});
