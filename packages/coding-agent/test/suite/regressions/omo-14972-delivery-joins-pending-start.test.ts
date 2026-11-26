/**
 * omo#14972: a delivery admitted while another delivery's start is still pending (its run has not begun) joins that
 * start, as a prompt joins a pending prompt start: the started turn's first provider request carries both, in admission
 * order. Before, it went to the follow-up queue and ran as a second turn after the first one ended.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const PROBE = /JOIN-PROBE-\d/g;

describe("a delivery admitted while a delivery start is pending (omo#14972)", () => {
	it("joins the pending start: the first provider request carries both deliveries in order", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const requests: string[][] = [];
		const record = (context: { readonly messages: readonly unknown[] }) => {
			requests.push(context.messages.flatMap((message) => getMessageText(message).match(PROBE) ?? []));
			return fauxAssistantMessage(`ack ${requests.length}`);
		};
		harness.setResponses([record, record]);
		const admission = harness.session.externalAdmission;

		const first = admission.admit({ delivery_id: "d-1", text: "JOIN-PROBE-1", deliverAs: "followUp" });
		const second = admission.admit({ delivery_id: "d-2", text: "JOIN-PROBE-2", deliverAs: "followUp" });
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		expect(first.kind).toBe("started");
		expect(second.kind).toBe("steered");
		expect(requests).toEqual([["JOIN-PROBE-1", "JOIN-PROBE-2"]]);
		expect(admission.list().pending).toEqual([]);
	});

	it("still queues a follow-up behind a run that has begun", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const requests: string[][] = [];
		let second: ReturnType<typeof harness.session.externalAdmission.admit> | undefined;
		const admission = harness.session.externalAdmission;
		const record = (context: { readonly messages: readonly unknown[] }) => {
			requests.push(context.messages.flatMap((message) => getMessageText(message).match(PROBE) ?? []));
			second ??= admission.admit({ delivery_id: "d-2", text: "JOIN-PROBE-2", deliverAs: "followUp" });
			return fauxAssistantMessage(`ack ${requests.length}`);
		};
		harness.setResponses([record, record]);

		admission.admit({ delivery_id: "d-1", text: "JOIN-PROBE-1", deliverAs: "followUp" });
		await harness.session.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		expect(second?.kind).toBe("queued");
		expect(requests).toEqual([["JOIN-PROBE-1"], ["JOIN-PROBE-1", "JOIN-PROBE-2"]]);
	});
});
