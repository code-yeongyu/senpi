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
	let delivery: ReturnType<typeof Promise.withResolvers<Readonly<Record<string, unknown>> | undefined>> | undefined;
	let baseline: (() => void) | undefined;
	const cancelledAnswer = async () => {
		const result = await host.admissions?.result(socketEpoch, admissionId);
		return result?.state === "cancelled"
			? {
					id,
					type: "response" as const,
					command: command.type,
					success: false as const,
					code: "attempt_cancelled",
					errorCode: "attempt_cancelled",
					error: "attempt_cancelled",
					admissionId,
					generation: 0,
				}
			: undefined;
	};
	try {
		const answer = await host.admissions.run({ peer, socketEpoch, admissionId, fingerprint }, async () => {
			let lease: EventLease | undefined;
			const subscribed = answerSubscribeSessions(command, peer, host.writer.status, (rows, subscriptionId) => {
				host.writer.registerSubscription(peer, admissionId, subscriptionId);
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
			const pending = host.writer.status.pendingBuffer(subscriptionId);
			if (!pending) throw new CompactAdmissionError("storage_unavailable");
			const eventLease = lease;
			const identity = { sessionId: subscriptionId, admissionId, generation: 0 };
			delivery = Promise.withResolvers();
			const reply = delivery.promise;
			let live = true;
			let installed = false;
			baseline = () => {
				if (installed) return;
				installed = true;
				host.writer.installAdmissionBaseline(
					peer,
					admissionBaseline(reply, { ...identity, eventLease, componentRef: "record" }, () => live),
					() => host.writer.socketEpochOf(peer) === socketEpoch,
				);
			};
			const { snapshot: _snapshot, ...data } = subscribed.answer.data;
			return {
				answer: { ...subscribed.answer, ...identity, data: { ...data, recovery: eventLease } },
				activate: () => {
					baseline?.();
					host.writer.status.activate(subscriptionId);
				},
				refusal: () =>
					pending.reason === undefined
						? undefined
						: {
								...error(undefined, command.type, pending.reason, {
									kind: "request_refused",
									reason: pending.reason,
									hint: "new_request",
								}),
								admissionId,
								generation: 0,
							},
				release: async () => {
					if (!live) return;
					live = false;
					host.writer.unregisterSubscription(peer, subscriptionId);
					host.writer.status.unsubscribe(peer, subscriptionId);
					events.abandon(socketEpoch, eventLease.id);
				},
			};
		});
		if (host.writer.socketEpochOf(peer) !== socketEpoch) {
			delivery?.resolve(undefined);
			return undefined;
		}
		const response = { ...((await cancelledAnswer()) ?? answer), id };
		if (delivery) {
			baseline?.();
			delivery.resolve(response);
		} else await host.writer.enqueueControl(response, peer);
		return undefined;
	} catch (cause) {
		if (!(cause instanceof CompactAdmissionError)) throw cause;
		const refusal =
			(await cancelledAnswer()) ??
			error(id, command.type, `admission_${cause.reason}`, {
				kind: "request_refused",
				reason: cause.reason,
				hint: "new_request",
			});
		if (delivery) {
			baseline?.();
			delivery.resolve({ ...refusal });
			return undefined;
		}
		return refusal;
	}
}
