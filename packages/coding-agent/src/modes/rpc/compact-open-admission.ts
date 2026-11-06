import { createHash } from "node:crypto";
import { CompactAdmissionError } from "./compact-admissions.ts";
import { admissionBaseline } from "./compact-admission-baseline.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { OpenRpcSession } from "./session-registry.ts";
import { RouteAnnouncement, type RouteRetirement } from "./route-retire-reasons.ts";
import { releaseDisconnectAttachment, releaseOwnerAttachment } from "./session-router-attachments.ts";
import type { RouterContext } from "./session-router-context.ts";
import { code, error } from "./session-router-errors.ts";

export type OpenAcceptance = (opened: OpenRpcSession) => Promise<void>;
type OpenCommand = Extract<RpcCommand, { type: "open_session" | "attach_session" }>;

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
	const { id: _request, admissionId, retry, ...request } = command;
	if (admissionId === undefined) throw new CompactAdmissionError("malformed_request");
	// Every request field participates; wire id, admission id and the retry marker do not change immutable open identity.
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
	let delivery: ReturnType<typeof Promise.withResolvers<Readonly<Record<string, unknown>> | undefined>> | undefined;
	let baseline: (() => void) | undefined;
	let completedOpen: { readonly sessionId: string; readonly release: () => Promise<void> } | undefined;
	// RULING-119: an accepted open that ends unanswered retires its route only once its tagged final reply is enqueued.
	let accepted: { readonly admissionId: string; readonly generation: number } | undefined;
	let announced: RouteAnnouncement | undefined;
	let retireAfterReply: ((retirement: RouteRetirement) => void) | undefined;
	const answerFinally = (emit: () => void) => {
		announced = RouteAnnouncement.emit("open_ended", emit);
		retireAfterReply?.(announced);
		retireAfterReply = undefined;
	};
	const cancelledAnswer = async () => {
		const result = await admissions.result(socketEpoch, admissionId);
		if (result?.state !== "cancelled" || typeof result.answer.generation !== "number") return undefined;
		return {
			id: command.id,
			type: "response" as const,
			command: command.type,
			success: false as const,
			error: "attempt_cancelled",
			errorCode: "attempt_cancelled",
			code: "attempt_cancelled",
			admissionId,
			generation: result.answer.generation,
		};
	};
	try {
		const identity = { socketEpoch, peer, admissionId, fingerprint, retry: retry === true };
		const answer = await admissions.run(identity, async (signal) => {
			let result:
				| { readonly answer: Readonly<Record<string, unknown>>; readonly release: () => Promise<void> }
				| undefined;
			let physicalSucceeded = false;
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
				accepted = { admissionId, generation: token.admission.generation };
				const retire = (retirement: RouteRetirement) => {
					checkpoints.retireRoute(caller, admissionId, retirement);
					host.writer.unregisterAdmission(peer, admissionId);
				};
				const release = async (superseded: boolean) => {
					if (!active) return;
					active = false;
					if (superseded) retire("reopen_superseded");
					else if (announced) retire(announced);
					else retireAfterReply = retire;
					// A failed physical open already rolled back its attachment.
					if (physicalSucceeded) {
						releaseOwnerAttachment(host, peer, sessionId);
						await releaseDisconnectAttachment(host, sessionId);
					}
				};
				completedOpen = { sessionId, release: () => release(true) };
				result = {
					answer: {
						type: "response",
						command: command.type,
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
					release: () => release(false),
				};
			}, signal).catch(async (cause: unknown) => {
				await result?.release();
				throw cause;
			});
			if (response !== undefined) {
				await result?.release();
				throw new OpenRefused(response);
			}
			if (result === undefined) throw new CompactAdmissionError("storage_unavailable");
			physicalSucceeded = true;
			return result;
		});
		const cancelled = await cancelledAnswer();
		const response = cancelled ?? { ...answer, id: command.id };
		if (delivery) {
			// RULING-117: only a completed open replaces the socket's earlier route to its session. The earlier open ends
			// (route, held id, attachment) before this baseline enters the actor, so later records carry this id only.
			const superseded =
				cancelled === undefined && answer.success === true && completedOpen
					? host.writer.supersedeOpen(peer, completedOpen.sessionId, admissionId, completedOpen.release)
					: undefined;
			void superseded?.().catch((cause: unknown) =>
				process.stderr.write(`senpi rpc superseded open release failed: ${String(cause)}\n`),
			);
			const reply = delivery;
			const deliver = () => {
				baseline?.();
				reply.resolve(response);
			};
			if (cancelled) answerFinally(deliver);
			else deliver();
		} else await host.writer.enqueueControl(response, peer);
		return undefined;
	} catch (cause) {
		delivery?.resolve(undefined);
		if (!(cause instanceof OpenRefused) && !(cause instanceof CompactAdmissionError)) {
			// A throwing handler gets no reply from the router, so an accepted open still ends with its own typed refusal.
			const unexpected = { ...error(command.id, command.type, code(cause)), ...accepted };
			if (accepted)
				answerFinally(() => {
					host.writer.enqueueControl(unexpected, peer).catch((written: unknown) => {
						process.stderr.write(`senpi rpc failed open's refusal not written: ${String(written)}\n`);
					});
				});
			throw cause;
		}
		const refusal =
			cause instanceof OpenRefused
				? cause.response
				: ((await cancelledAnswer()) ??
					error(command.id, command.type, `admission_${cause.reason}`, {
						kind: "request_refused",
						reason: cause.reason,
						hint: "new_request",
					}));
		if (accepted === undefined) return refusal;
		// The accepted open may already have delivered records under its id: its refusal names it and is the last one.
		const ended = { ...refusal, ...accepted };
		let written: Promise<void> | undefined;
		answerFinally(() => {
			written = host.writer.enqueueControl(ended, peer);
		});
		await written;
		return undefined;
	}
}
