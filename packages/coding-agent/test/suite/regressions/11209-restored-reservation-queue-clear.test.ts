import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0).reverse()) harness.cleanup();
});

async function restoreDelivery(deliverAs: "steer" | "followUp") {
	const original = await createHarness({ persistSession: true });
	harnesses.push(original);
	await original.sessionManager.persistHeaderNow();
	const input = { delivery_id: "clear-before-recovery", text: "peer input", deliverAs };
	const ticket = original.session.workObligations
		.open(`delivery:${SESSION_CONTROL_DELIVERY_TYPE}:${input.delivery_id}`, "background")
		.ticket();
	original.session.workObligations.queue(ticket, {
		message: {
			customType: SESSION_CONTROL_DELIVERY_TYPE,
			content: input.text,
			display: true,
			details: { delivery_id: input.delivery_id, source: "session_control", deliverAs },
		},
		deliverAs,
	});
	original.session.workObligations.endDelivery(ticket);
	const file = original.sessionManager.getSessionFile();
	if (file === undefined) throw new Error("No persisted session");
	original.session.dispose();
	const reopened = await createHarness({ siblingOf: original, sessionManager: SessionManager.open(file) });
	harnesses.push(reopened);
	return { reopened, input, ticket };
}

it.each(["steer", "followUp"] as const)(
	"keeps restored %s custody reserved across a clear before recovery enqueues its carrier",
	async (lane) => {
		const { reopened, input, ticket } = await restoreDelivery(lane);
		reopened.setResponses([fauxAssistantMessage("ack"), fauxAssistantMessage("duplicate ack")]);
		// The binding exists, but bindExtensions has not started recovery or enqueued the carrier.
		reopened.session.clearQueue();
		expect(reopened.session.workObligations.active.find((record) => record.ticketId === ticket)?.state).toBe(
			"queued",
		);
		let admissionKind: string | undefined;
		const afterConsume: string[] = [];
		const unsubscribe = reopened.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === SESSION_CONTROL_DELIVERY_TYPE
			)
				afterConsume.push(
					reopened.session.externalAdmission.admit({
						...input,
						expected_turn_id: reopened.session.externalAdmission.turnEpoch,
					}).kind,
				);
			if (event.type !== "agent_start" || admissionKind !== undefined) return;
			admissionKind = reopened.session.externalAdmission.admit({
				...input,
				expected_turn_id: reopened.session.externalAdmission.turnEpoch,
			}).kind;
		});
		try {
			await reopened.session.bindExtensions({ mode: "rpc" });
			await reopened.session.waitForIdle();
		} finally {
			unsubscribe();
		}
		expect(
			reopened.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE),
		).toHaveLength(1);
		expect(admissionKind).toBe("already_admitted");
		expect(afterConsume).toEqual(["already_admitted"]);
		expect(reopened.eventsOfType("message_end").filter((event) => event.message.role === "assistant")).toHaveLength(
			1,
		);
	},
);

it.each(["cancel", "retire", "passive"] as const)(
	"releases a restored reservation when custody is %s without persisting its carrier",
	async (release) => {
		const { reopened, input, ticket } = await restoreDelivery("followUp");
		expect(reopened.session.externalAdmission.list().pending).toContain(input.delivery_id);
		reopened.session.workObligations[release](ticket);
		// No second clear or persistence event is needed to make a gateway redelivery eligible.
		expect(reopened.session.externalAdmission.admit({ ...input, whenIdle: "queue" }).kind).toBe("queued");
		reopened.session.clearQueue();
		expect(reopened.session.externalAdmission.list().pending).not.toContain(input.delivery_id);
	},
);
