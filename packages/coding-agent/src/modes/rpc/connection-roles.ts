import { readAuthority, effectiveRoles } from "./connection-authority.ts";
import { commandAuthority } from "./command-authority.ts";
import { INTERACTIVE_USER_CAPABILITY, TASK_PARENT_CAPABILITY } from "./custom-capability.ts";
import type { DelegationDescriptor } from "./delegation-record.ts";
import { type DelegationResolution, resolveDelegation } from "./delegation-resolve.ts";
import { type RpcRemoteOrigin, sameRemoteOrigin } from "./remote-origin.ts";

/**
 * Connection roles (senpi#3811): the capabilities that say who a connection speaks for, which is what
 * authority checks read. A role belongs to one connection, never to a session: a shared host serves every
 * connection attached to a session through one binding. Only the client's own `set_client_info` declares a
 * role; launch defaults (`SENPI_RPC_CLIENT_CAPABILITIES`, a host's connection options) never do, so a client
 * can still declare after it attached. Once a connection declared, a different declaration is refused.
 *
 * On a host-mode delegated connection (omo-relay-daemon#307) a claim belongs to one incarnation of the socket and
 * counts only while that incarnation's authority word still holds the role and is not retired. A claim for an
 * incarnation is created only by a declaration that carries that incarnation while it is the record's current, open
 * one: `declare` is the single place that check runs, and `isStale` is its side-effect-free preflight.
 */
export const CONNECTION_ROLE_CAPABILITIES: readonly string[] = [INTERACTIVE_USER_CAPABILITY, TASK_PARENT_CAPABILITY];

/** The one connection of a single-session `--mode rpc` process. */
export const SOLE_CONNECTION = "sole-connection";

/**
 * The key a connection's roles are kept under. A stdio host (and a worker isolate serving it) reads lines
 * with no connection id; its one client is the sole connection, so the role is still declared once and fixed.
 */
export function roleConnection(connectionId: string | undefined): string {
	return connectionId ?? SOLE_CONNECTION;
}

export const CONNECTION_ROLE_FIXED =
	"connection_role_fixed: interactive_user and task_parent cannot change after they are declared";

export const DELEGATION_INCARNATION_STALE =
	"delegation_incarnation_stale: this declaration was made before detach_connection; declare again";

export type RoleDeclaration = "declared" | "fixed" | "stale";

/** What the roles need of a delegated connection: its principal, mode and current incarnation. */
export interface DelegatedConnectionView {
	readonly descriptor: DelegationDescriptor;
	readonly closed: boolean;
}

/** Untagged claims (local, stdio, legacy-mode delegated connections) are kept under incarnation 0. */
const UNTAGGED = 0;

export class ConnectionRoles {
	private readonly claims = new Map<string, Map<number, readonly string[]>>();
	private readonly origins = new Map<string, RpcRemoteOrigin>();
	/** A worker isolate's first-seen delegation per connection (`retain`), kept for the worker's life. */
	private readonly retained = new Map<string, DelegationDescriptor>();
	private source: ((connectionId: string) => DelegatedConnectionView | undefined) | undefined;

	/** The host reads each connection's live record from its writer's delegations. */
	useDelegations(source: (connectionId: string) => DelegatedConnectionView | undefined): void {
		this.source = source;
	}

	private viewOf(connectionId: string): DelegatedConnectionView | undefined {
		if (this.source) return this.source(connectionId);
		const descriptor = this.retained.get(connectionId);
		return descriptor === undefined ? undefined : { descriptor, closed: false };
	}

	/**
	 * Whether a declaration carrying `incarnation` must be refused as stale, with no side effect. On the host the
	 * record's current, open incarnation is the only one that may claim; in a worker an incarnation older than the one it
	 * retained is stale (the host's answer stays authoritative). Without a host-mode record only an untagged one proceeds.
	 */
	isStale(connectionId: string, incarnation: number | undefined): boolean {
		const view = this.viewOf(connectionId);
		if (view?.descriptor.mode !== "host") return incarnation !== undefined;
		const current = view.descriptor.incarnation;
		if (this.source === undefined) return incarnation === undefined || incarnation < (current ?? 0);
		return view.closed || incarnation !== current;
	}

	/** Records the roles a `set_client_info` carries for one incarnation, or why it may not. */
	declare(connectionId: string, capabilities: readonly string[], incarnation?: number): RoleDeclaration {
		if (this.isStale(connectionId, incarnation)) return "stale";
		const roles = CONNECTION_ROLE_CAPABILITIES.filter((role) => capabilities.includes(role));
		const key = incarnation ?? UNTAGGED;
		const prior = this.claims.get(connectionId)?.get(key);
		if (prior !== undefined)
			return prior.length === roles.length && prior.every((role) => roles.includes(role)) ? "declared" : "fixed";
		this.claimsOf(connectionId).set(key, roles);
		return "declared";
	}

	private claimsOf(connectionId: string): Map<number, readonly string[]> {
		let claims = this.claims.get(connectionId);
		if (claims === undefined) {
			claims = new Map();
			this.claims.set(connectionId, claims);
		}
		return claims;
	}

	/** The roles declared for `incarnation` (untagged when omitted), or undefined while none were (no id = stdio). */
	rolesOf(connectionId: string | undefined, incarnation?: number): readonly string[] | undefined {
		return this.claims.get(roleConnection(connectionId))?.get(incarnation ?? UNTAGGED);
	}

	/** Takes a declaration made on the host, unless this incarnation already declared; drops older incarnations' claims. */
	adopt(connectionId: string, roles: readonly string[], incarnation?: number): void {
		const claims = this.claimsOf(connectionId);
		const key = incarnation ?? UNTAGGED;
		for (const older of claims.keys()) if (older < key) claims.delete(older);
		if (!claims.has(key)) claims.set(key, [...roles]);
	}

	/** Worker isolate: resolves a bind/command's carried delegation against the one retained for the connection. */
	retain(connectionId: string, wire: DelegationDescriptor): DelegationResolution {
		const { resolution, retain } = resolveDelegation(this.retained.get(connectionId), wire);
		if (retain !== undefined) this.retained.set(connectionId, retain);
		return resolution;
	}

	/** Whether `origin` may be declared: none yet or the same again (senpi#5475); a delegated one is its principal. */
	acceptsOrigin(connectionId: string, origin: RpcRemoteOrigin): boolean {
		if (this.viewOf(connectionId) !== undefined) return true;
		const prior = this.origins.get(connectionId);
		return prior === undefined || sameRemoteOrigin(prior, origin);
	}

	/** Records the remote device a local connection speaks for; a delegated connection's origin is never declared. */
	declareOrigin(connectionId: string, origin: RpcRemoteOrigin): void {
		if (this.viewOf(connectionId) !== undefined) return;
		if (this.acceptsOrigin(connectionId, origin)) this.origins.set(connectionId, origin);
	}

	/** The remote device this connection speaks for: a delegated connection's principal, else its declared origin. */
	originOf(connectionId: string | undefined): RpcRemoteOrigin | undefined {
		const key = roleConnection(connectionId);
		const principal = this.viewOf(key)?.descriptor.principal;
		if (principal === undefined) return this.origins.get(key);
		return principal.deviceName === undefined
			? { deviceId: principal.deviceId }
			: { deviceId: principal.deviceId, deviceName: principal.deviceName };
	}

	/** Whether the connection is delegated (a remote device's), on the host or as a worker retained it. */
	isDelegated(connectionId: string | undefined): boolean {
		return this.viewOf(roleConnection(connectionId)) !== undefined;
	}

	has(connectionId: string | undefined, role: string): boolean {
		const key = roleConnection(connectionId);
		const store = commandAuthority.getStore();
		if (store !== undefined && roleConnection(store.connection) === key)
			return store.has(role, this.rolesOf(key, store.incarnation));
		const descriptor = this.viewOf(key)?.descriptor;
		const claim = this.rolesOf(key, descriptor?.incarnation);
		if (descriptor?.mode !== "host" || descriptor.authority === undefined) return claim?.includes(role) ?? false;
		return effectiveRoles(claim, readAuthority(descriptor.authority)).includes(role);
	}

	/** A logical detach: drops claims of earlier incarnations of a delegated socket, and everything of a local one. */
	release(connectionId: string): void {
		const descriptor = this.viewOf(connectionId)?.descriptor;
		if (descriptor?.mode !== "host") {
			this.claims.delete(connectionId);
			this.origins.delete(connectionId);
			return;
		}
		const claims = this.claims.get(connectionId);
		const current = descriptor.incarnation ?? UNTAGGED;
		for (const key of claims?.keys() ?? []) if (key < current) claims?.delete(key);
	}

	/** The socket is gone: nothing of it is kept. */
	forget(connectionId: string): void {
		this.claims.delete(connectionId);
		this.origins.delete(connectionId);
		this.retained.delete(connectionId);
	}

	/** Forgets every connection, for a worker isolate whose session ends. */
	clear(): void {
		this.claims.clear();
		this.origins.clear();
		this.retained.clear();
	}
}
