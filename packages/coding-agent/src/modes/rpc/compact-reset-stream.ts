import { admissionBaseline } from "./compact-admission-baseline.ts";
import type { RpcCommand } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** A reset operates on existing admission authority, not a fresh open or an attachment. */
export async function resetStream(host: RouterContext, command: Extract<RpcCommand, { type: "reset_stream" }>) {
	const peer = host.writer.currentConnection();
	const socketEpoch = peer === undefined ? undefined : host.writer.socketEpochOf(peer);
	const { sessionId, admissionId } = command;
	const refused = () =>
		error(command.id, command.type, "recovery_unknown_token", { kind: "repair_needed", reason: "unknown_token" });
	if (!host.admissions || peer === undefined || socketEpoch === undefined || sessionId === undefined) return refused();
	const result = await host.admissions.result(socketEpoch, admissionId);
	if (result?.state !== "complete" || result.answer.sessionId !== sessionId) return refused();
	const checkpoints = host.writer.recoveryCheckpoints;
	const caller = { socketEpoch, sessionId };
	const stream = checkpoints.stream(caller);
	const lane = host.writer.recoveryLane(sessionId);
	if (!lane || !stream?.routes.includes(admissionId)) return refused();
	const frozen = checkpoints.freeze({ ...caller, peer, admissionId, routeKind: "ordinary" }, lane);
	if (!frozen.ok) return error(command.id, command.type, `recovery_${frozen.failure.kind}`, { ...frozen.failure });
	const token = frozen.value.token;
	const generation = token.admission.generation;
	const answer = {
		id: command.id,
		type: "response",
		command: "reset_stream",
		success: true,
		sessionId,
		admissionId,
		generation,
		data: { recovery: { token: token.id, componentRef: "manifest" } },
	};
	host.writer.installAdmissionBaseline(
		peer,
		admissionBaseline(
			Promise.resolve(answer),
			{ sessionId, admissionId, generation, token: token.id },
			() => true,
			stream.routes,
		),
		() => host.writer.socketEpochOf(peer) === socketEpoch,
	);
	return undefined;
}
