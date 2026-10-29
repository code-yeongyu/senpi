import { createHash } from "node:crypto";
import { CompactAdmissionError } from "./compact-admissions.ts";
import { admissionBaseline } from "./compact-admission-baseline.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { OpenRpcSession } from "./session-registry.ts";
import { releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

export type OpenAcceptance = (opened: OpenRpcSession) => Promise<void>;
type OpenCommand = Extract<RpcCommand, { type: "open_session" }>;

class OpenRefused extends Error {
	readonly response: RpcResponse;

	constructor(response: RpcResponse) {
		super("compact open refused");
		this.response = response;
		this.name = "OpenRefused";
	}
}

/** Register the client's ID before physical open; identical pending/completed retries never open again. */
export async function compactOpen(
	host: RouterContext,
	command: OpenCommand,
	physical: (accept: OpenAcceptance, signal: AbortSignal) => Promise<RpcResponse | undefined>,
): Promise<RpcResponse | undefined> {
	const peer = host.writer.currentConnection();
	const socketEpoch = peer === undefined ? undefined : host.writer.socketEpochOf(peer);
	const admissions = host.admissions;
	if (peer === undefined || socketEpoch === undefined || admissions === undefined)
		return error(command.id, command.type, "unsupported_transport");
	const { id: _request, admissionId, ...request } = command;
	if (admissionId === undefined) throw new CompactAdmissionError("malformed_request");
	// Every request field participates; wire id and admission id do not change immutable open identity.
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
	let delivery: ReturnType<typeof Promise.withResolvers<Readonly<Record<string, unknown>> | undefined>> | undefined;
	let baseline: (() => void) | undefined;
	const cancelledAnswer = async () => {
		const result = await admissions.result(socketEpoch, admissionId);
		if (result?.state !== "cancelled" || typeof result.answer.generation !== "number") return undefined;
		return {
			id: command.id,
			type: "response" as const,
			command: "open_session" as const,
			success: false as const,
			error: "attempt_cancelled",
			errorCode: "attempt_cancelled",
			code: "attempt_cancelled",
			admissionId,
			generation: result.answer.generation,
		};
	};
	try {
		const answer = await admissions.run({ socketEpoch, peer, admissionId, fingerprint }, async (signal) => {
			let result:
				| { readonly answer: Readonly<Record<string, unknown>>; readonly release: () => Promise<void> }
				| undefined;
			const response = await physical(async (opened) => {
				const sessionId = opened.sessionId;
				const lane = host.writer.recoveryLane(sessionId);
				if (!lane) throw new CompactAdmissionError("storage_unavailable");
				const caller = { socketEpoch, sessionId };
				const checkpoints = host.writer.recoveryCheckpoints;
				const frozen = checkpoints.freeze({ ...caller, peer, admissionId, routeKind: "ordinary" }, lane, true);
				if (!frozen.ok) throw new CompactAdmissionError("storage_unavailable");
				const token = frozen.value.token;
				const identity = { sessionId, admissionId, generation: token.admission.generation, token: token.id };
				let active = true;
				delivery = Promise.withResolvers<Readonly<Record<string, unknown>> | undefined>();
				const reply = delivery.promise;
				host.writer.registerAdmission(peer, admissionId, sessionId);
				baseline = () =>
					host.writer.installAdmissionBaseline(
						peer,
						admissionBaseline(reply, identity, () => active),
						() => host.writer.socketEpochOf(peer) === socketEpoch,
					);
				result = {
					answer: {
						type: "response",
						command: "open_session",
						success: true,
						sessionId,
						admissionId,
						generation: token.admission.generation,
						data: {
							sessionId,
							...(opened.attached ? { attached: true } : {}),
							recovery: { token: token.id, componentRef: "manifest" },
						},
					},
					release: async () => {
						active = false;
						checkpoints.retireRoute(caller, admissionId);
						releaseOwnerAttachment(host, peer, sessionId);
						await releaseDisconnectAttachment(host, sessionId);
					},
				};
			}, signal);
			if (response !== undefined) throw new OpenRefused(response);
			if (result === undefined) throw new CompactAdmissionError("storage_unavailable");
			return result;
		});
		const response = (await cancelledAnswer()) ?? { ...answer, id: command.id };
		if (delivery) {
			baseline?.();
			delivery.resolve(response);
		} else await host.writer.enqueueControl(response, peer);
		return undefined;
	} catch (cause) {
		delivery?.resolve(undefined);
		if (cause instanceof OpenRefused) return cause.response;
		if (!(cause instanceof CompactAdmissionError)) throw cause;
		const cancelled = await cancelledAnswer();
		if (cancelled) return cancelled;
		return error(command.id, command.type, `admission_${cause.reason}`, {
			kind: "request_refused",
			reason: cause.reason,
			hint: "new_request",
		});
	}
}
