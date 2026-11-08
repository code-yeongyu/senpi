/**
 * Writes what the delegated-connection gate decided instead of dispatching (senpi#5632, senpi#4249 R-1b d1/d2).
 * A private presenter outcome goes through the private write (`writeMcpFormReply`) and never the control queue, so
 * it keeps the private shape's promise: no event queue, snapshot, mirror or replay.
 */
import { type DelegationResponse, type DelegationVerdict, refused, requestId } from "./delegation-wire.ts";
import { PRESENTER_CONTROL_INFO_COMMAND } from "./delegated-presenter-records.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

/** A host-mode record whose `relayExec` is not a positive safe integer is refused, never dispatched (#307). */
export function relayExecRefusal(record: unknown): DelegationResponse {
	const object = typeof record === "object" && record !== null ? record : {};
	const type: unknown = Reflect.get(object, "type");
	return refused(
		requestId(object),
		typeof type === "string" ? type : "parse",
		"delegation_malformed",
		"relayExec must be a positive safe integer",
	);
}

export async function answerDelegation(
	writer: SessionEventWriter,
	verdict: Exclude<DelegationVerdict, { readonly kind: "pass" }>,
	record: unknown,
): Promise<void> {
	switch (verdict.kind) {
		case "consumed":
			return;
		case "reply":
			await writer.enqueueControl(verdict.response);
			return;
		case "private":
			writer.writeMcpFormReply(verdict.id, { error: verdict.error });
			return;
		case "presenter":
			// An engine without presenter enforcement has no authority to hand it to: still the private shape.
			if (!writer.handleMcpForm(record)) writer.writeMcpFormReply(verdict.id, { error: "presenter_not_authorized" });
			return;
		case "control_info": {
			const controlEndpoint = writer.mcpPresenterControlEndpoint;
			await writer.enqueueControl({
				...(verdict.id === undefined ? {} : { id: verdict.id }),
				type: "response",
				command: PRESENTER_CONTROL_INFO_COMMAND,
				success: true,
				data: controlEndpoint === undefined ? {} : { controlEndpoint },
			});
			return;
		}
	}
}
