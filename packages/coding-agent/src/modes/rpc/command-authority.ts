/**
 * One authority snapshot per command (omo-relay-daemon#307). A host-mode delegated line runs inside a
 * `CommandAuthority`: its first role check takes the one `Atomics.load` of the captured incarnation's word, every later
 * check in the same command reuses it, and the responses that command produces carry the receipt
 * `authority: {exec, incarnation, epoch, roles}` when the forwarder numbered the record with `relayExec`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { type AuthorityState, decodeWord, effectiveRoles } from "./connection-authority.ts";
import type { DelegationDescriptor } from "./delegation-record.ts";

export interface AuthorityReceipt {
	readonly exec: number;
	readonly incarnation: number | null;
	readonly epoch: number | null;
	/** The effective roles the command's role checks read, or null when it consulted none. */
	readonly roles: readonly string[] | null;
}

export class CommandAuthority {
	readonly connection: string | undefined;
	readonly descriptor: DelegationDescriptor | undefined;
	readonly exec: number | undefined;
	/** A worker command of an older incarnation than the one it retained: every role check reads retired. */
	private readonly stale: boolean;
	private snapshot: AuthorityState | undefined;
	private consulted: readonly string[] | undefined;

	constructor(
		connection: string | undefined,
		descriptor: DelegationDescriptor | undefined,
		exec: number | undefined,
		stale = false,
	) {
		this.connection = connection;
		this.descriptor = descriptor;
		this.exec = exec;
		this.stale = stale;
	}

	get incarnation(): number | undefined {
		return this.descriptor?.incarnation;
	}

	private state(): AuthorityState | undefined {
		const buffer = this.descriptor?.mode === "host" ? this.descriptor.authority : undefined;
		if (buffer === undefined) return undefined;
		this.snapshot ??= decodeWord(Atomics.load(new Int32Array(buffer), 0));
		return this.stale ? { ...this.snapshot, retired: true } : this.snapshot;
	}

	/** Whether `claim` (this command's incarnation's claim) grants `role`, read from the one snapshot. */
	has(role: string, claim: readonly string[] | undefined): boolean {
		const state = this.state();
		if (state === undefined) return claim?.includes(role) ?? false;
		const effective = effectiveRoles(claim, state);
		this.consulted = effective;
		return effective.includes(role);
	}

	receipt(): AuthorityReceipt | undefined {
		if (this.exec === undefined) return undefined;
		const buffer = this.descriptor?.authority;
		const state =
			this.snapshot ?? (buffer === undefined ? undefined : decodeWord(Atomics.load(new Int32Array(buffer), 0)));
		return {
			exec: this.exec,
			incarnation: this.descriptor?.incarnation ?? null,
			epoch: state?.epoch ?? null,
			roles: this.consulted === undefined ? null : [...this.consulted],
		};
	}
}

export const commandAuthority = new AsyncLocalStorage<CommandAuthority>();

/**
 * Runs `create` outside any command's authority. On Node, a Worker (and every MessagePort) runs its listeners in the
 * async context it was constructed in, so a session worker created by a role-bound command would otherwise stamp that
 * command's receipt onto every later response it forwards. Anything long-lived a command creates is built through this.
 */
export function outsideCommand<T>(create: () => T): T {
	return commandAuthority.exit(create);
}

/**
 * Adds the running command's receipt to a response addressed to that command's connection. A response that already
 * has a top-level `authority` (a worker's own, stamped where it ran) is never overwritten.
 */
export function withReceipt<T extends object>(record: T, target: string | undefined): T {
	if (Reflect.get(record, "type") !== "response" || Object.hasOwn(record, "authority")) return record;
	const store = commandAuthority.getStore();
	if (store === undefined || store.connection !== target) return record;
	const authority = store.receipt();
	return authority === undefined ? record : { ...record, authority };
}

/**
 * Takes the forwarder's `relayExec` out of a host-mode record before anything else sees it: a positive safe integer,
 * absent, or `"malformed"` for any other value.
 */
export function takeRelayExec(record: unknown): number | undefined | "malformed" {
	if (typeof record !== "object" || record === null || !Object.hasOwn(record, "relayExec")) return undefined;
	const exec: unknown = Reflect.get(record, "relayExec");
	Reflect.deleteProperty(record, "relayExec");
	return typeof exec === "number" && Number.isSafeInteger(exec) && exec >= 1 ? exec : "malformed";
}
