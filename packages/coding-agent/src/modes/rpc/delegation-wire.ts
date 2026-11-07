/**
 * The answers the delegated-connection gate gives (senpi#5632, senpi#4249 R-1b d1): an ordinary response in the
 * router's error shape, or, for a private presenter record on a delegated connection, the private reply shape
 * `handleMcpForm` writes, so a forwarder routes it by type and never to a pending command.
 */

/** A response record the gate answers with, in the router's error shape (`session-router-errors.ts`). */
export interface DelegationResponse {
	readonly id?: string;
	readonly type: "response";
	readonly command: string;
	readonly success: boolean;
	readonly [field: string]: unknown;
}

/** The refusal codes of omo-relay-spec decision 0018 (`delegationRefusal`). */
export type DelegationRefusal =
	| "delegation_malformed"
	| "delegation_unclassified"
	| "delegation_local_only"
	| "delegation_not_granted"
	| "delegation_unauthenticated"
	| "delegation_late"
	| "delegation_fixed";

export type PrivateRefusal = "delegation_unclassified" | "delegation_not_granted" | "presenter_not_authorized";

/**
 * `pass`: dispatch as today. `consumed`: nothing to answer. `reply`: answer this instead of dispatching.
 * `private`: answer this private refusal straight to the connection. `presenter`: a private presenter record the
 * grant permits, for the presenter authority. `control_info`: the asker may learn the presenter control endpoint.
 */
export type DelegationVerdict =
	| { readonly kind: "pass" }
	| { readonly kind: "consumed" }
	| { readonly kind: "reply"; readonly response: DelegationResponse }
	| { readonly kind: "private"; readonly id: string | undefined; readonly error: PrivateRefusal }
	| { readonly kind: "presenter"; readonly id: string | undefined }
	| { readonly kind: "control_info"; readonly id: string | undefined };

export function requestId(record: object): string | undefined {
	const id: unknown = Reflect.get(record, "id");
	return typeof id === "string" ? id : undefined;
}

export function refused(
	id: string | undefined,
	command: string,
	code: DelegationRefusal | "presenter_not_authorized",
	message: string,
	data?: Readonly<Record<string, unknown>>,
): DelegationResponse {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: false,
		error: `${code}: ${message}`,
		errorCode: code,
		...(data === undefined ? {} : { errorData: data }),
	};
}
