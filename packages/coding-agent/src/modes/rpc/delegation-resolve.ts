/**
 * How a worker isolate turns the delegation descriptor a bind or command carries into the one it reads
 * (omo-relay-daemon#307). Structured clone gives every message a new wrapper around the same memory, so the worker
 * keeps the FIRST buffer it saw for an incarnation and compares scalars only, never wrapper identity.
 */
import type { DelegationDescriptor } from "./delegation-record.ts";
import { samePrincipal } from "./delegation-declaration.ts";
import { incarnationOf, readAuthority } from "./connection-authority.ts";

export type DelegationResolution =
	/** Read `descriptor` (the retained buffer for its incarnation). */
	| { readonly kind: "use"; readonly descriptor: DelegationDescriptor }
	/** An older incarnation than the retained one: the command runs, its role checks read retired. */
	| { readonly kind: "stale"; readonly descriptor: DelegationDescriptor }
	/** A principal, mode or stamp that cannot belong to this connection: that one command is refused. */
	| { readonly kind: "conflict" };

export const DELEGATION_AUTHORITY_CONFLICT = "delegation_authority_conflict";

/** The one command's refusal when its carried delegation conflicts: non-fatal, no `session_worker_` prefix. */
export function authorityConflict(command: object): object {
	const id: unknown = Reflect.get(command, "id");
	const type: unknown = Reflect.get(command, "type");
	return {
		...(typeof id === "string" ? { id } : {}),
		type: "response",
		command: typeof type === "string" ? type : "parse",
		success: false,
		error: DELEGATION_AUTHORITY_CONFLICT,
		errorCode: DELEGATION_AUTHORITY_CONFLICT,
	};
}

export function resolveDelegation(
	retained: DelegationDescriptor | undefined,
	wire: DelegationDescriptor,
): { readonly resolution: DelegationResolution; readonly retain?: DelegationDescriptor } {
	if (retained !== undefined && (retained.mode !== wire.mode || !samePrincipal(retained.principal, wire.principal)))
		return { resolution: { kind: "conflict" } };
	if (wire.mode === "legacy") return { resolution: { kind: "use", descriptor: retained ?? wire } };
	const incarnation = wire.incarnation;
	if (incarnation === undefined || wire.authority === undefined || incarnationOf(wire.authority) !== incarnation)
		return { resolution: { kind: "conflict" } };
	if (retained === undefined) return { resolution: { kind: "use", descriptor: wire }, retain: wire };
	const kept = retained.incarnation ?? 0;
	if (incarnation === kept) return { resolution: { kind: "use", descriptor: retained } };
	if (incarnation < kept) return { resolution: { kind: "stale", descriptor: wire } };
	// The host retires k before it issues k+1, so a newer incarnation over a live retained word cannot be genuine.
	if (retained.authority === undefined || !readAuthority(retained.authority).retired)
		return { resolution: { kind: "conflict" } };
	return { resolution: { kind: "use", descriptor: wire }, retain: wire };
}
