/**
 * Delegated connections (senpi#5632): the engine enforces its own method-class table on a connection that speaks for
 * someone else, so a forwarder (a relay host forwarding a remote viewer's records) keeps no table of its own.
 *
 * A connection that proved the endpoint's launch key may declare, before any record other than `get_protocol_info`
 * or `authenticate`, that it acts for a principal with a set of granted classes (`declare_delegation`). A later
 * declaration may only narrow it. From then on every inbound record on that connection is classified
 * (`classifyRpcMethod`) and checked against the grant here, synchronously at line receipt and before anything else
 * sees it: lines of one connection are not serialized, so a declaration and the record written right behind it are
 * decided in order. A permitted record then runs exactly as on a local connection, schema problems included: only what
 * the local path also refuses before dispatch (not an object, no string `type`) is refused here as malformed, so a
 * delegated connection accepts exactly what a local one accepts.
 *
 * `connection_local` records follow `CONNECTION_LOCAL_REQUIREMENT`. A connection that never declares is not affected: the
 * only records this module answers on it are the two methods it adds (`declare_delegation`, `classify_record`).
 *
 * Neither method is in `RPC_METHOD_CLASS`: adding them would change `RPC_METHOD_CLASSES_DIGEST`, and a forwarder that
 * pins the digest would then refuse every record (senpi#5632 rollout split, S1a).
 *
 * senpi#4249 R-1b: on a delegated connection a private presenter record (`mcp_form_*`, `mcp_presenter_*`) is decided
 * by `delegated-presenter-records.ts` and always answered in the private reply shape; `mcp_presenter_control_info`
 * is answered only on a launch-proven connection that is not delegated.
 */

import { type Principal, parseDeclaration, samePrincipal } from "./delegation-declaration.ts";
import { type DelegationResponse, type DelegationVerdict, refused, requestId } from "./delegation-wire.ts";
import {
	isPrivatePresenterType,
	PRESENTER_CONTROL_INFO_COMMAND,
	privatePresenterVerdict,
} from "./delegated-presenter-records.ts";
import {
	classifyRpcMethod,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	RPC_METHOD_CLASSES_VERSION,
	type RpcMethodClass,
	type RpcMethodType,
} from "./method-classes.ts";
import { RPC_LAUNCH_PROOF_RECORD } from "./rpc-auth-proof.ts";

export type { DelegationRefusal, DelegationResponse, DelegationVerdict } from "./delegation-wire.ts";

const DECLARE_DELEGATION_COMMAND = "declare_delegation";
const CLASSIFY_RECORD_COMMAND = "classify_record";

/**
 * How a connection's transport proves the launch key: `proven` at admission (the Windows socket secret), `in_band`
 * when the public-key filter in front of it delivers `RPC_LAUNCH_PROOF_RECORD` after a successful `authenticate`
 * (the bare host's own filter, or the supervisor's for a relayed connection; both refuse that record from a client).
 */
export type LaunchProofSource = "proven" | "in_band";

type ConnectionLocalType = {
	[K in RpcMethodType]: (typeof RPC_METHOD_CLASS)[K] extends "connection_local" ? K : never;
}[RpcMethodType];

/**
 * What a delegated connection needs for each `connection_local` method (DS2b section 2c): `self` acts only on the
 * asking connection; `subscribe_sessions` reveals the same rows as `list_sessions` (`observe`); `record_user_activity`
 * changes session-wide activity the agent's timing reads (`drive`); `device_admin` reaches the host (hands a session
 * over, loads a cwd's extensions, takes a session by host path, moves session files). `set_client_info` stays `self`
 * and unfiltered: a viewer's roles come from its own records. Exhaustive, so a new `connection_local` method fails the
 * typecheck until it is placed.
 */
const CONNECTION_LOCAL_REQUIREMENT = {
	set_client_info: "self",
	subscribe_sessions: "observe",
	unsubscribe_sessions: "self",
	record_user_activity: "drive",
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
} as const satisfies Record<ConnectionLocalType, "self" | Exclude<RpcMethodClass, "connection_local">>;

/** The records a connection may send before its first declaration without making that declaration late. */
const PRE_DECLARATION: ReadonlySet<unknown> = new Set(["get_protocol_info", "authenticate", RPC_LAUNCH_PROOF_RECORD]);
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
		// A connection with a proof source only receives this record from its own transport (the filters refuse it from
		// clients); one proven at admission (the Windows supervisor's hop) already counts and just drops it.
		if (type === RPC_LAUNCH_PROOF_RECORD && state?.proofSource !== undefined) {
			state.proven = true;
			return CONSUMED;
		}
		if (type === DECLARE_DELEGATION_COMMAND)
			return { kind: "reply", response: this.declaration(state, record as object) };
		if (type === CLASSIFY_RECORD_COMMAND) {
			if (state) state.spoken = true;
			return { kind: "reply", response: classifyRecord(record as object) };
		}
		if (type === PRESENTER_CONTROL_INFO_COMMAND && state?.delegation === undefined) {
			if (state) state.spoken = true;
			return state?.proven === true
				? { kind: "control_info", id: requestId(record as object) }
				: {
						kind: "reply",
						response: refused(
							requestId(record as object),
							PRESENTER_CONTROL_INFO_COMMAND,
							"presenter_not_authorized",
							"mcp_presenter_control_info needs a connection that proved the endpoint's launch key",
						),
					};
		}
		if (state === undefined) return PASS;
		if (!PRE_DECLARATION.has(type)) state.spoken = true;
		const delegation = state.delegation;
		if (delegation === undefined) return PASS;
		if (isPrivatePresenterType(type))
			return privatePresenterVerdict(type, requestId(record as object), delegation.granted);
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
	if (typeof type !== "string")
		return refused(id, "parse", "delegation_malformed", "a record is a JSON object with a string type");
	const command = type;
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
		`${command} on a delegated connection needs the ${required} grant`,
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
