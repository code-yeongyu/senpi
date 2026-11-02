/**
 * The schemas of the socket host's recovery and admission records (senpi#4272): pages under a checkpoint token or an
 * event lease, the lease receipt, and the attempt cancel and stream reset. Each names its own required `admissionId`.
 */

import Type from "typebox";
import { admissionSession, Id, literals, OptId } from "./method-classes-schema-fields.ts";

export const RECOVERY_RECORD_SCHEMAS = {
	// every field is a bounded id at the token owner (`parseBoundedId`); a cursor is at most 128 bytes. A page is
	// asked under a checkpoint token or, since S13, under an event lease (senpi#4272)
	get_recovery_page: Type.Union([
		admissionSession("get_recovery_page", {
			token: Id,
			admissionId: Id,
			componentRef: Id,
			requestId: Id,
			cursor: OptId,
		}),
		admissionSession("get_recovery_page", {
			lease: Type.Object({ kind: literals("event", "checkpoint"), id: Id }),
			admissionId: Id,
			componentRef: Id,
			requestId: Id,
			cursor: OptId,
		}),
	]),
	// the receipt for an event lease this connection holds; `admissionId` scopes it to the asking connection's admission
	release_recovery: admissionSession("release_recovery", {
		lease: Type.Object({ kind: Type.Literal("event"), id: Id }),
		admissionId: Id,
	}),
	// cancels this connection's own admission attempt (S15a-0); `admissionId` names an attempt on the asking socket epoch
	cancel_attempt: admissionSession("cancel_attempt", { admissionId: Id }),
	// resets this connection's own stream onto a fresh checkpoint under an admission it completed (S15a-1)
	reset_stream: admissionSession("reset_stream", { admissionId: Id }),
};
