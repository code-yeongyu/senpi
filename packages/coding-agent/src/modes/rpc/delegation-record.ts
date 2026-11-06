/**
 * A delegated socket's state for its whole life (omo-relay-daemon#307): created at its first `declare_delegation`,
 * kept through `detach_connection` and physical close, deleted only once the socket is gone (`forget`).
 *
 * The first declaration fixes the mode: with `roles` it is `host` mode and owns an authority word per incarnation,
 * without them it is `legacy` mode and roles stay the client's own claims, as before. A logical `detach_connection`
 * retires the current incarnation's word and issues the next one with the same (already narrowed) mask, so a detach
 * never widens and a claim made before it never counts after it.
 */
import {
	createAuthority,
	INCARNATION_MAX,
	maskOfRoles,
	nextIncarnation,
	readAuthority,
	rolesOfMask,
	storeNarrowed,
	storeRetired,
} from "./connection-authority.ts";
import { type Declaration, type Principal, samePrincipal } from "./delegation-declaration.ts";
import type { RpcMethodClass } from "./method-classes.ts";

/** What a line captures before its first await and what `bind`/`command` carry to a worker. */
export interface DelegationDescriptor {
	readonly principal: Principal;
	readonly mode: "legacy" | "host";
	/** Host mode: this incarnation's number, also stamped into `authority[1]`. */
	readonly incarnation?: number;
	/** Host mode: this incarnation's word at index 0. */
	readonly authority?: SharedArrayBuffer;
}

export interface DelegationIncarnation {
	readonly incarnation: number;
	readonly authority: SharedArrayBuffer;
}

export interface DelegationRecord {
	readonly principal: Principal;
	readonly mode: "legacy" | "host";
	granted: ReadonlySet<RpcMethodClass>;
	current: DelegationIncarnation | undefined;
	lastIncarnation: number;
	closed: boolean;
}

export function createRecord(
	principal: Principal,
	granted: ReadonlySet<RpcMethodClass>,
	roles: ReadonlySet<string> | undefined,
): DelegationRecord {
	if (roles === undefined)
		return { principal, mode: "legacy", granted, current: undefined, lastIncarnation: 0, closed: false };
	return {
		principal,
		mode: "host",
		granted,
		current: { incarnation: 1, authority: createAuthority(1, maskOfRoles(roles)) },
		lastIncarnation: 1,
		closed: false,
	};
}

/**
 * A later declaration on an existing record: the principal stays, `granted` and `roles` only narrow (`delegation_fixed`
 * otherwise; `roles` on a legacy record too). Omitted `roles` keeps the mask. False when it must be refused.
 */
export function narrowRecord(record: DelegationRecord, parsed: Declaration): boolean {
	if (!samePrincipal(record.principal, parsed.principal)) return false;
	if ([...parsed.granted].some((c) => !record.granted.has(c))) return false;
	if (parsed.roles !== undefined) {
		if (record.current === undefined) return false;
		const mask = readAuthority(record.current.authority).roles;
		if ([...parsed.roles].some((role) => !mask.includes(role))) return false;
		storeNarrowed(record.current.authority, parsed.roles);
	}
	record.granted = parsed.granted;
	return true;
}

/** The `data.roles` echo of a host-mode declaration reply: the mask after it, in canonical order. */
export function echoedRoles(record: DelegationRecord): { roles?: string[] } {
	const current = record.current;
	return current === undefined ? {} : { roles: rolesOfMask(readAuthority(current.authority).mask) };
}

export function descriptorOf(record: DelegationRecord): DelegationDescriptor {
	const current = record.current;
	return current === undefined
		? { principal: record.principal, mode: record.mode }
		: { principal: record.principal, mode: record.mode, ...current };
}

/**
 * `detach_connection` on a host-mode record: retire k, then issue k+1 with k's mask at epoch 1. Returns false when the
 * counter is exhausted: k stays retired, the record is closed, and the caller ends the socket.
 */
export function rotateIncarnation(record: DelegationRecord, max = INCARNATION_MAX): boolean {
	const current = record.current;
	if (record.mode !== "host" || current === undefined || record.closed) return true;
	storeRetired(current.authority);
	const next = nextIncarnation(record.lastIncarnation, max);
	if (next === undefined) {
		record.closed = true;
		return false;
	}
	record.lastIncarnation = next;
	record.current = { incarnation: next, authority: createAuthority(next, readAuthority(current.authority).mask) };
	return true;
}

/** Physical close: the current word reads retired from now on; the record stays until the socket is forgotten. */
export function closeRecord(record: DelegationRecord): void {
	if (record.current !== undefined) storeRetired(record.current.authority);
	record.closed = true;
}
