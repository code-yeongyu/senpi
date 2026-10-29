import { createHash } from "node:crypto";
import { CompactAdmissionError } from "./compact-admissions.ts";
import type { EventLease } from "./compact-recovery-types.ts";
import { statusSnapshot } from "./compact-status-snapshot.ts";
import { admissionBaseline } from "./compact-admission-baseline.ts";
import type { RpcCommand } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";
import { answerSubscribeSessions } from "./session-status-commands.ts";

/** The existing attempt index also owns mirror answers and late cleanup by the returned server ID. */
export async function compactSubscribe(
	host: RouterContext,
	command: Extract<RpcCommand, { type: "subscribe_sessions" }>,
) {
	const peer = host.writer.currentConnection();
	const socketEpoch = peer === undefined ? undefined : host.writer.socketEpochOf(peer);
	const events = host.writer.recoveryEvents;
	const { admissionId, id, ...request } = command;
	if (peer === undefined || socketEpoch === undefined || !events || !host.admissions || admissionId === undefined)
		return error(id, command.type, "unsupported_transport");
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
	let delivery: ReturnType<typeof Promise.withResolvers<Readonly<Record<string, unknown>>>> | undefined;
	try {
		const answer = await host.admissions.run({ peer, socketEpoch, admissionId, fingerprint }, async () => {
			let lease: EventLease | undefined;
			const subscribed = answerSubscribeSessions(command, peer, host.writer.status, (rows, subscriptionId) => {
				lease = statusSnapshot(events, socketEpoch, admissionId, subscriptionId, rows);
			});
			const subscriptionId = subscribed.activate;
			if (
				!subscribed.answer.success ||
				subscribed.answer.command !== "subscribe_sessions" ||
				subscriptionId === undefined
			) {
				return { answer: { ...subscribed.answer }, release: async () => {} };
			}
			if (lease === undefined) throw new CompactAdmissionError("storage_unavailable");
			const eventLease = lease;
			const identity = { sessionId: subscriptionId, admissionId, generation: 0 };
			delivery = Promise.withResolvers();
			const reply = delivery.promise;
			let live = true;
			host.writer.installAdmissionBaseline(
				peer,
				admissionBaseline(reply, { ...identity, eventLease, componentRef: "record" }, () => live),
				() => host.writer.socketEpochOf(peer) === socketEpoch,
			);
			// All subsequent status changes enter the bounded actor behind this barrier, never pending.lines[].
			host.writer.registerSubscription(peer, admissionId, subscriptionId);
			host.writer.status.activate(subscriptionId);
			const { snapshot: _snapshot, ...data } = subscribed.answer.data;
			return {
				answer: { ...subscribed.answer, ...identity, data: { ...data, recovery: eventLease } },
				release: async () => {
					live = false;
					host.writer.status.unsubscribe(peer, subscriptionId);
					events.abandon(socketEpoch, eventLease.id);
				},
			};
		});
		const response = { ...answer, id };
		if (delivery) delivery.resolve(response);
		else await host.writer.enqueueControl(response, peer);
		return undefined;
	} catch (cause) {
		if (!(cause instanceof CompactAdmissionError)) throw cause;
		const refusal = error(id, command.type, `admission_${cause.reason}`, {
			kind: "request_refused",
			reason: cause.reason,
			hint: "new_request",
		});
		if (delivery) {
			delivery.resolve({ ...refusal });
			return undefined;
		}
		return refusal;
	}
}
