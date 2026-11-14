/** The typed refusals of the endpoint reservation store (sisyphuslabs/omo-desktop-app#4199, design 4.2a). */
export type ReservationRejection =
	| "store_insecure"
	| "store_busy"
	| "schema_unsupported"
	| "generation_unknown"
	| "generation_cancelled"
	| "generation_not_pending"
	| "endpoint_mismatch"
	| "role_not_offered"
	| "role_already_offered"
	| "role_not_expected"
	| "role_already_claimed"
	| "role_released"
	| "role_not_claimed"
	| "role_not_granted"
	| "nonce_mismatch"
	| "participant_mismatch"
	| "issuer_mismatch"
	| "commitment_invalid"
	| "roles_not_granted";

/** A typed refusal; `reason` is machine-readable and the message never carries a nonce. */
export class EndpointReservationError extends Error {
	readonly code = "endpoint-reservation-rejected";
	readonly reason: ReservationRejection;

	constructor(reason: ReservationRejection, detail: string, options?: ErrorOptions) {
		super(`endpoint reservation ${reason}: ${detail}`, options);
		this.name = "EndpointReservationError";
		this.reason = reason;
	}
}
