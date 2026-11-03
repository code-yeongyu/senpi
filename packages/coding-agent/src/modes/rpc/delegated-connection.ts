/**
 * Delegated connections (senpi#5632): the engine enforces its own method-class table on a connection that speaks for
 * someone else, so a forwarder (a relay host forwarding a remote viewer's records) keeps no table of its own.
 *
 * A connection that proved the endpoint's launch key may declare, before any record other than `get_protocol_info`
 * or `authenticate`, that it acts for a principal with a set of granted classes (`declare_delegation`). A later
 * declaration may only narrow it. From then on every inbound record on that connection is validated
 * (`validateRpcInboundRecord`), classified (`classifyRpcMethod`) and checked against the grant here, synchronously at
 * line receipt and before anything else sees it: lines of one connection are not serialized, so a declaration and the
 * record written right behind it are decided in order. A permitted record then runs exactly as on a local connection.
 *
 * `connection_local` records act on the asking connection itself and are permitted, except the host-wide ones
 * (`CONNECTION_LOCAL_REQUIREMENT`), which need `device_admin`. A connection that never declares is not affected: the
 * only records this module answers on it are the two methods it adds (`declare_delegation`, `classify_record`).
 *
 * Neither method is in `RPC_METHOD_CLASS`: adding them would change `RPC_METHOD_CLASSES_DIGEST`, and a forwarder that
 * pins the digest would then refuse every record (senpi#5632 rollout split, S1a).
 */

import {
	classifyRpcMethod,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	RPC_METHOD_CLASSES_VERSION,
	type RpcMethodClass,
	type RpcMethodType,
} from "./method-classes.ts";
import { validateRpcInboundRecord } from "./method-classes-schema.ts";
import { RPC_LAUNCH_PROOF_RECORD } from "./rpc-auth-proof.ts";

export const DECLARE_DELEGATION_COMMAND = "declare_delegation";
export const CLASSIFY_RECORD_COMMAND = "classify_record";

/**
 * How a connection's transport proves the launch key: `proven` at admission (the Windows socket secret), `in_band`
 * when the public-key filter in front of it delivers `RPC_LAUNCH_PROOF_RECORD` after a successful `authenticate`
 * (the bare host's own filter, or the supervisor's for a relayed connection; both refuse that record from a client).
 */
export type LaunchProofSource = "proven" | "in_band";

/** A response record this module answers with, in the router's error shape (`session-router-errors.ts`). */
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

type ConnectionLocalType = {
	[K in RpcMethodType]: (typeof RPC_METHOD_CLASS)[K] extends "connection_local" ? K : never;
}[RpcMethodType];

/**
 * What a delegated connection needs for each `connection_local` method: `self` acts only on the asking connection;
 * `device_admin` reaches the host (hands a session over, loads a cwd's extensions, takes a session by host path,
 * moves session files). Exhaustive, so a new `connection_local` method fails the typecheck until it is placed.
 */
const CONNECTION_LOCAL_REQUIREMENT = {
	set_client_info: "self",
	subscribe_sessions: "self",
	unsubscribe_sessions: "self",
	record_user_activity: "self",
	detach_connection: "self",
	release_session: "device_admin",
	warm: "device_admin",
	host_response: "self",
	release_attachment: "self",
	reclaim_session: "device_admin",
	move_session: "device_admin",
	get_recovery_page: "self",
	release_recovery: "self",
	cancel_attempt: "self",
	reset_stream: "self",
} as const satisfies Record<ConnectionLocalType, "self" | "device_admin">;

const FORWARDABLE_CLASSES: ReadonlySet<string> = new Set<Exclude<RpcMethodClass, "connection_local">>([
	"observe",
	"drive",
	"answer",
	"thread",
	"device_admin",
]);
/** The records a connection may send before its first declaration without making that declaration late. */
const PRE_DECLARATION: ReadonlySet<unknown> = new Set(["get_protocol_info", "authenticate", RPC_LAUNCH_PROOF_RECORD]);
const MAX_PRINCIPAL_FIELD = 256;
const MAX_CONN_FIELD = 64;

interface Principal {
	readonly deviceId: string;
	readonly deviceName?: string;
	readonly conn?: string;
}

interface Delegation {
	readonly principal: Principal;
	granted: ReadonlySet<RpcMethodClass>;
}

interface ConnectionState {
	readonly proofSource: LaunchProofSource | undefined;
	proven: boolean;
	spoken: boolean;
	delegation: Delegation | undefined;
}

/** `pass`: dispatch as today. `consumed`: nothing to answer. `reply`: answer this instead of dispatching. */
export type DelegationVerdict =
	| { readonly kind: "pass" }
	| { readonly kind: "consumed" }
	| { readonly kind: "reply"; readonly response: DelegationResponse };

const PASS: DelegationVerdict = { kind: "pass" };
const CONSUMED: DelegationVerdict = { kind: "consumed" };

/** Per-connection delegation state of one host; keyed by the connection id the writer runs each line under. */
export class ConnectionDelegations {
	private readonly connections = new Map<string, ConnectionState>();

	admit(id: string, proofSource: LaunchProofSource | undefined): void {
		// A re-registration under a live id keeps its state: forgetting a delegation would widen it.
		if (this.connections.has(id)) return;
		this.connections.set(id, {
			proofSource,
			proven: proofSource === "proven",
			spoken: false,
			delegation: undefined,
		});
	}

	drop(id: string): void {
		this.connections.delete(id);
	}

	isDelegated(id: string | undefined): boolean {
		return id !== undefined && this.connections.get(id)?.delegation !== undefined;
	}

	/** The answer to a line that is not JSON: today's parse error, typed `malformed` on a delegated connection. */
	unparsable(id: string | undefined, error: string): DelegationResponse {
		return {
			type: "response",
			command: "parse",
			success: false,
			error,
			...(this.isDelegated(id) ? { errorCode: "delegation_malformed" } : {}),
		};
	}

	/** Decides one parsed inbound record of connection `id`. Synchronous: it runs before any await of the line. */
	inspect(id: string | undefined, record: unknown): DelegationVerdict {
		const state = id === undefined ? undefined : this.state(id);
		const type = typeof record === "object" && record !== null ? Reflect.get(record, "type") : undefined;
		if (type === RPC_LAUNCH_PROOF_RECORD && state?.proofSource === "in_band") {
			state.proven = true;
			return CONSUMED;
		}
		if (type === DECLARE_DELEGATION_COMMAND)
			return { kind: "reply", response: this.declaration(state, record as object) };
		if (type === CLASSIFY_RECORD_COMMAND) {
			if (state) state.spoken = true;
			return { kind: "reply", response: classifyRecord(record as object) };
		}
		if (state === undefined) return PASS;
		if (!PRE_DECLARATION.has(type)) state.spoken = true;
		const delegation = state.delegation;
		if (delegation === undefined) return PASS;
		const refusal = refuseOnDelegation(record, delegation.granted);
		return refusal === undefined ? PASS : { kind: "reply", response: refusal };
	}

	private state(id: string): ConnectionState {
		let state = this.connections.get(id);
		if (state === undefined) {
			state = { proofSource: undefined, proven: false, spoken: false, delegation: undefined };
			this.connections.set(id, state);
		}
		return state;
	}

	private declaration(state: ConnectionState | undefined, record: object): DelegationResponse {
		const id = requestId(record);
		const parsed = parseDeclaration(record);
		if (typeof parsed === "string") return refused(id, DECLARE_DELEGATION_COMMAND, "delegation_malformed", parsed);
		if (state === undefined || !state.proven)
			return refused(
				id,
				DECLARE_DELEGATION_COMMAND,
				"delegation_unauthenticated",
				"declare_delegation needs a connection that proved the endpoint's launch key",
			);
		const current = state.delegation;
		if (current !== undefined) {
			if (
				!samePrincipal(current.principal, parsed.principal) ||
				[...parsed.granted].some((c) => !current.granted.has(c))
			)
				return refused(
					id,
					DECLARE_DELEGATION_COMMAND,
					"delegation_fixed",
					"a delegated connection keeps its principal and can only narrow its grant",
				);
			current.granted = parsed.granted;
		} else if (state.spoken) {
			return refused(
				id,
				DECLARE_DELEGATION_COMMAND,
				"delegation_late",
				"declare_delegation must come before any record other than get_protocol_info or authenticate",
			);
		} else {
			state.delegation = { principal: parsed.principal, granted: parsed.granted };
		}
		return {
			...(id === undefined ? {} : { id }),
			type: "response",
			command: DECLARE_DELEGATION_COMMAND,
			success: true,
			data: { granted: [...parsed.granted], digest: RPC_METHOD_CLASSES_DIGEST },
		};
	}
}

function refuseOnDelegation(record: unknown, granted: ReadonlySet<RpcMethodClass>): DelegationResponse | undefined {
	const object = typeof record === "object" && record !== null && !Array.isArray(record) ? record : undefined;
	const id = object === undefined ? undefined : requestId(object);
	const type = object === undefined ? undefined : Reflect.get(object, "type");
	const command = typeof type === "string" ? type : "parse";
	const validation = validateRpcInboundRecord(record);
	if (!validation.ok) {
		// An unknown type is the classifier's verdict, not a shape error: the engine's default refuses it.
		const unclassified = typeof type === "string" && !Object.hasOwn(RPC_METHOD_CLASS, type);
		return unclassified
			? refused(id, command, "delegation_unclassified", `the engine does not classify ${command}`)
			: refused(id, command, "delegation_malformed", validation.reason);
	}
	const methodClass = classifyRpcMethod(record);
	if (methodClass === undefined)
		return refused(id, command, "delegation_unclassified", `the engine does not classify ${command}`);
	if (methodClass !== "connection_local")
		return granted.has(methodClass)
			? undefined
			: refused(id, command, "delegation_not_granted", `${command} needs the ${methodClass} grant`, {
					class: methodClass,
				});
	const required = CONNECTION_LOCAL_REQUIREMENT[command as ConnectionLocalType];
	if (required === "self" || granted.has(required)) return undefined;
	return refused(
		id,
		command,
		"delegation_local_only",
		`${command} reaches beyond this connection and needs the ${required} grant`,
		{ class: required },
	);
}

function classifyRecord(record: object): DelegationResponse {
	const id = requestId(record);
	const target: unknown = Reflect.get(record, "record");
	const methodClass = classifyRpcMethod(target);
	const type = typeof target === "object" && target !== null ? Reflect.get(target, "type") : undefined;
	const entry =
		methodClass !== undefined && typeof type === "string" ? RPC_METHOD_CLASS[type as RpcMethodType] : undefined;
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command: CLASSIFY_RECORD_COMMAND,
		success: true,
		data: {
			class: methodClass ?? null,
			version: RPC_METHOD_CLASSES_VERSION,
			digest: RPC_METHOD_CLASSES_DIGEST,
			...(entry === undefined
				? {}
				: typeof entry === "string"
					? { static: true }
					: { static: false, rule: entry.version }),
		},
	};
}

function parseDeclaration(
	record: object,
): { readonly principal: Principal; readonly granted: ReadonlySet<RpcMethodClass> } | string {
	const principal: unknown = Reflect.get(record, "principal");
	if (typeof principal !== "object" || principal === null || Array.isArray(principal))
		return "principal must be an object";
	const deviceId: unknown = Reflect.get(principal, "deviceId");
	const deviceName: unknown = Reflect.get(principal, "deviceName");
	const conn: unknown = Reflect.get(principal, "conn");
	if (!boundedString(deviceId, MAX_PRINCIPAL_FIELD)) return "principal.deviceId must be 1-256 characters";
	if (deviceName !== undefined && !boundedString(deviceName, MAX_PRINCIPAL_FIELD))
		return "principal.deviceName must be 1-256 characters";
	if (conn !== undefined && !boundedString(conn, MAX_CONN_FIELD)) return "principal.conn must be 1-64 characters";
	const granted: unknown = Reflect.get(record, "granted");
	if (!Array.isArray(granted)) return "granted must be an array of method classes";
	const classes = new Set<RpcMethodClass>();
	for (const entry of granted) {
		if (typeof entry !== "string" || !FORWARDABLE_CLASSES.has(entry) || classes.has(entry as RpcMethodClass))
			return "granted holds each of observe, drive, answer, thread, device_admin at most once";
		classes.add(entry as RpcMethodClass);
	}
	return {
		principal: {
			deviceId: deviceId as string,
			...(deviceName === undefined ? {} : { deviceName: deviceName as string }),
			...(conn === undefined ? {} : { conn: conn as string }),
		},
		granted: classes,
	};
}

function boundedString(value: unknown, max: number): boolean {
	return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function samePrincipal(a: Principal, b: Principal): boolean {
	return a.deviceId === b.deviceId && a.deviceName === b.deviceName && a.conn === b.conn;
}

function requestId(record: object): string | undefined {
	const id: unknown = Reflect.get(record, "id");
	return typeof id === "string" ? id : undefined;
}

function refused(
	id: string | undefined,
	command: string,
	code: DelegationRefusal,
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
