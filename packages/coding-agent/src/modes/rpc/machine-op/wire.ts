/**
 * The `machine_op` record family (senpi#6752): the local relay host hands the engine the `run` step of one device
 * operation and gets back its `OpOutcome`, the relay host's own result shape. None of these records is in
 * `RPC_METHOD_CLASS` (the digest forwarders pin stays as it is); `delegated-connection.ts` answers them only on a
 * launch-proven connection that declared no delegation.
 *
 * `machine_op { op, args, op_id, deadline_ms?, scope: { root, confined }, sender }`: `op_id` is opaque (the relay host
 * sends `JSON.stringify([sender, batch_id, op_id])`) and its cached answer is bound to `sender`; `deadline_ms` is an absolute
 * epoch-ms time on this machine's clock, absent for an op with no deadline; `scope` is the relay host's own scope
 * verdict for the op, `sender` the device it runs for. `machine_op_result` and `machine_op_cancel { op_id, sender }`
 * read or abort only that sender's op, and the terminal ops act only on that sender's handles: another sender's is
 * refused (`machine_op_conflict`, `not_owner`) unless the record carries `cross_owner: true`, which the relay host sets
 * only after its own admin verdict on another sender's op or handle.
 * `env_overlay` (optional, string values, set only by the relay host) is laid LAST over the environment of a `shell` or
 * `exec_command` child, over `args.env` too: the relay host tells its children its own state dir this way (#1247).
 * Byte payloads travel base64 in JSON (`args.bytes`, `response.bytes`); an 8 MiB write fits in one 16 MiB line.
 */
import { type DelegationResponse, refused } from "../delegation-wire.ts";

const MACHINE_OP_COMMANDS = [
	"machine_op",
	"machine_op_result",
	"machine_op_owner",
	"machine_op_health",
	"machine_op_cancel",
] as const;
export type MachineOpCommand = (typeof MACHINE_OP_COMMANDS)[number];

/** Advertised in `get_protocol_info` by a host that answers these records. */
export const MACHINE_OP_CAPABILITY = "machine_op_v1";

const COMMANDS: ReadonlySet<unknown> = new Set(MACHINE_OP_COMMANDS);
export const isMachineOpCommand = (type: unknown): type is MachineOpCommand => COMMANDS.has(type);

export type Args = Readonly<Record<string, unknown>>;
export type OpError = Readonly<{ code: string; message: string }>;
export type OpState = "applied" | "failed" | "refused" | "cancelled" | "timed_out";
/** The relay host's `OpOutcome`, answered unchanged as a `machine_op` response's `data`. */
export type OpOutcome = Readonly<{ state: OpState; response?: Readonly<Record<string, unknown>>; error?: OpError }>;
export type OpScope = Readonly<{ root: string; confined: boolean }>;

export interface MachineOpRequest {
	readonly op: string;
	readonly args: Args;
	readonly opId: string;
	readonly deadlineMs: number | undefined;
	readonly scope: OpScope;
	readonly sender: string;
	readonly envOverlay: Readonly<Record<string, string>>;
	readonly crossOwner: boolean;
}

/** `machine_op_result` / `machine_op_cancel`: whose op it is asking about. */
export interface OwnedOpLookup {
	readonly opId: string;
	readonly sender: string;
	readonly crossOwner: boolean;
}

export function machineOpRefusal(id: string | undefined, command: MachineOpCommand): DelegationResponse {
	return refused(
		id,
		command,
		"machine_op_not_authorized",
		`${command} needs a connection that proved the endpoint's launch key and declared no delegation`,
	);
}

export function machineOpMalformed(id: string | undefined, command: MachineOpCommand, problem: string) {
	return refused(id, command, "machine_op_malformed", problem);
}

export function machineOpConflict(id: string | undefined, command: MachineOpCommand): DelegationResponse {
	return refused(id, command, "machine_op_conflict", "op_id is bound to another sender");
}

/** Retryable: the engine could not run the op now (its state dir, or a host that is ending); nothing ran or is cached. */
export function machineOpUnavailable(id: string | undefined, detail: string): DelegationResponse {
	return refused(id, "machine_op", "machine_op_unavailable", detail);
}

export function machineOpAnswer(id: string | undefined, command: MachineOpCommand, data: unknown): DelegationResponse {
	return { ...(id === undefined ? {} : { id }), type: "response", command, success: true, data };
}

export const isArgs = (value: unknown): value is Args =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const nonEmptyText = (record: Args, key: string): string | undefined => {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

const crossOwnerOf = (record: Args): boolean | string =>
	record.cross_owner === undefined || typeof record.cross_owner === "boolean"
		? record.cross_owner === true
		: "cross_owner must be a boolean";

/** The op a `machine_op_result` / `machine_op_cancel` names and who asks, or the first problem with them. */
export function parseOwnedOpLookup(record: Args): OwnedOpLookup | string {
	const opId = nonEmptyText(record, "op_id");
	if (opId === undefined) return "op_id must be a non-empty string";
	const sender = nonEmptyText(record, "sender");
	if (sender === undefined) return "sender must be a non-empty string";
	const crossOwner = crossOwnerOf(record);
	return typeof crossOwner === "string" ? crossOwner : { opId, sender, crossOwner };
}

/** The `machine_op` record's fields, or the first problem with them. */
export function parseMachineOp(record: Args): MachineOpRequest | string {
	const op = nonEmptyText(record, "op");
	if (op === undefined) return "op must be a non-empty string";
	const args = record.args;
	if (!isArgs(args)) return "args must be a map";
	const opId = nonEmptyText(record, "op_id");
	if (opId === undefined) return "op_id must be a non-empty string";
	const deadlineMs = record.deadline_ms;
	if (
		deadlineMs !== undefined &&
		(typeof deadlineMs !== "number" || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)
	)
		return "deadline_ms must be a positive epoch-ms integer";
	const scope = record.scope;
	if (
		!isArgs(scope) ||
		typeof scope.root !== "string" ||
		!scope.root.startsWith("/") ||
		typeof scope.confined !== "boolean"
	)
		return "scope must be { root: <absolute path>, confined: <boolean> }";
	const sender = nonEmptyText(record, "sender");
	if (sender === undefined) return "sender must be a non-empty string";
	const overlay = record.env_overlay ?? {};
	if (!isArgs(overlay) || !Object.values(overlay).every((value) => typeof value === "string"))
		return "env_overlay must be a map of strings";
	const envOverlay = Object.fromEntries(Object.entries(overlay).map(([key, value]) => [key, String(value)]));
	const crossOwner = crossOwnerOf(record);
	if (typeof crossOwner === "string") return crossOwner;
	const scoped = { root: scope.root, confined: scope.confined };
	return { op, args, opId, deadlineMs, scope: scoped, sender, envOverlay, crossOwner };
}
