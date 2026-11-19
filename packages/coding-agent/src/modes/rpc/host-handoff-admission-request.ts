/**
 * The handoff admission, as the REQUESTER asks for it (senpi#7044): `admit_handoff` before anything is spawned,
 * over a connection it keeps open, and `drain_for_handoff` over that same connection once its successor owns the
 * socket. The connection is what binds the admission (`host-handoff-admission.ts`): closing it gives the admission
 * up, and the drain it carries reaches the host that admitted, whoever serves the public path by then.
 */
import type { EngineBuildIdentity } from "../../core/engine-build-identity.ts";
import { ADMIT_HANDOFF_COMMAND, DRAIN_FOR_HANDOFF_COMMAND } from "./host-handoff-admission.ts";
import { askOnSocket, connectAndAsk, isRecord } from "./host-socket-request.ts";

const ADMISSION_REQUEST_ID = "handoff-admission";
const DRAIN_REQUEST_ID = "handoff-drain";

/**
 * What the host that admitted made of its admission shown back. `gone`: its connection ended with no answer, so
 * it is leaving already - it noticed on its own that it lost the public socket. `unconfirmed`: it is still
 * connected and refused, or did not answer in time.
 */
export type AdmittedDrainOutcome = "draining" | "gone" | "unconfirmed";

/** An admission the running host granted, held on the connection it was granted on. */
export interface HandoffAdmission {
	/** Presents the admission to the host that granted it. */
	drain(timeoutMs: number): Promise<AdmittedDrainOutcome>;
	/** Ends the connection, and with it an admission that was not used. */
	close(): void;
}

/** Why no admission was granted; the first three are the host's own answer. */
export type HandoffAdmissionRefusal =
	| "older_engine"
	| "unordered_engine"
	| "handoff_unsupported"
	/** Nothing accepted a connection on the socket any more. */
	| "no_host"
	/** The host gave no usable answer, or refused for a reason this build does not know. */
	| "not_admitted";

export type HandoffAdmissionOutcome =
	| { readonly admitted: true; readonly admission: HandoffAdmission }
	| { readonly admitted: false; readonly reason: HandoffAdmissionRefusal; readonly detail?: string };

export async function requestHandoffAdmission(
	socket: string,
	terms: { readonly successorEngine: EngineBuildIdentity; readonly allowDowngrade: boolean },
	timeoutMs: number,
): Promise<HandoffAdmissionOutcome> {
	const asked = await connectAndAsk(
		socket,
		{
			id: ADMISSION_REQUEST_ID,
			type: ADMIT_HANDOFF_COMMAND,
			successor_engine: { text: terms.successorEngine.text, ordinal: terms.successorEngine.ordinal },
			...(terms.allowDowngrade && { allow_downgrade: true }),
		},
		timeoutMs,
		true,
	);
	const kept = asked.kept;
	const answer = asked.answer;
	if (kept !== undefined && isRecord(answer) && typeof answer.admission_id === "string") {
		const admissionId = answer.admission_id;
		return {
			admitted: true,
			admission: {
				drain: async (drainTimeoutMs) => {
					const drained = await askOnSocket(
						kept,
						{ id: DRAIN_REQUEST_ID, type: DRAIN_FOR_HANDOFF_COMMAND, admission_id: admissionId },
						drainTimeoutMs,
					);
					if (isRecord(drained) && drained.draining === true) return "draining";
					return drained === undefined && kept.destroyed ? "gone" : "unconfirmed";
				},
				close: () => kept.destroy(),
			},
		};
	}
	kept?.destroy();
	if (!asked.connected) return { admitted: false, reason: "no_host" };
	if (!isRecord(answer) || typeof answer.refused !== "string") {
		return { admitted: false, reason: "not_admitted", detail: "the running host did not answer admit_handoff" };
	}
	const detail = typeof answer.detail === "string" ? answer.detail : undefined;
	switch (answer.refused) {
		case "older_engine":
		case "unordered_engine":
		case "handoff_unsupported":
			return { admitted: false, reason: answer.refused, ...(detail !== undefined && { detail }) };
		default:
			return {
				admitted: false,
				reason: "not_admitted",
				detail: detail === undefined ? answer.refused : `${answer.refused}: ${detail}`,
			};
	}
}
