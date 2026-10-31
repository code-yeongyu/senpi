import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

// omo#11209: the gateway retries a claim whose receiver died after recording delivery custody.
it.each([false, true])(
	"writes a recovered delivery once when its gateway retries at run start (history=%s)",
	async (history) => {
		// Given the same queued custody sendCustomMessage writes before its first await, without a delivery entry.
		const original = await createHarness({ persistSession: true });
		harnesses.push(original);
		if (history) {
			original.setResponses([fauxAssistantMessage("earlier reply")]);
			await original.session.prompt("earlier input");
		}
		await original.sessionManager.persistHeaderNow();
		const input = { delivery_id: "receiver-crash", text: "peer input", deliverAs: "followUp" as const };
		const ticket = original.session.workObligations
			.open(`delivery:${SESSION_CONTROL_DELIVERY_TYPE}:${input.delivery_id}`, "background")
			.ticket();
		original.session.workObligations.queue(ticket, {
			message: {
				customType: SESSION_CONTROL_DELIVERY_TYPE,
				content: input.text,
				display: true,
				details: { delivery_id: input.delivery_id, source: "session_control", deliverAs: input.deliverAs },
			},
		});
		original.session.workObligations.endDelivery(ticket);
		const file = original.sessionManager.getSessionFile();
		if (file === undefined) throw new Error("No persisted session");
		expect(original.sessionManager.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
		original.session.dispose();

		const reopened = await createHarness({
			siblingOf: original,
			sessionManager: SessionManager.open(file),
		});
		harnesses.push(reopened);
		reopened.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("duplicate ack")]);
		let admissionKind: string | undefined;
		const unsubscribe = reopened.session.subscribe((event) => {
			if (event.type !== "agent_start" || admissionKind !== undefined) return;
			admissionKind = reopened.session.externalAdmission.admit(input).kind;
		});

		// When restoration starts its carrier, a gateway pass retries before that carrier's message_end.
		try {
			await reopened.session.bindExtensions({ mode: "rpc" });
			await reopened.session.waitForIdle();
		} finally {
			unsubscribe();
		}

		// Then custody recovery and gateway admission have one owner and produce one durable entry and model turn.
		const deliveries = reopened.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE);
		expect(deliveries).toHaveLength(1);
		expect(admissionKind).toBe("already_admitted");
		expect(reopened.eventsOfType("message_end").filter((event) => event.message.role === "assistant")).toHaveLength(
			1,
		);
		expect(
			readFileSync(file, "utf8")
				.split("\n")
				.filter(
					(line) => line.includes('"delivery_id":"receiver-crash"') && line.includes('"type":"custom_message"'),
				),
		).toHaveLength(1);
	},
);
