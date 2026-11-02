import { INTERACTIVE_USER_CAPABILITY, TASK_PARENT_CAPABILITY } from "./custom-capability.ts";

/**
 * Connection roles (senpi#3811): the capabilities that say who a connection speaks for, which is what
 * authority checks read. A role belongs to one connection, never to a session: a shared host serves every
 * connection attached to a session through one binding. Only the client's own `set_client_info` declares a
 * role; launch defaults (`SENPI_RPC_CLIENT_CAPABILITIES`, a host's connection options) never do, so a client
 * can still declare after it attached. Once a connection declared, a different declaration is refused.
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

export class ConnectionRoles {
	private readonly declared = new Map<string, readonly string[]>();

	/** Records the roles a `set_client_info` carries; false when this connection already declared other roles. */
	declare(connectionId: string, capabilities: readonly string[]): boolean {
		const roles = CONNECTION_ROLE_CAPABILITIES.filter((role) => capabilities.includes(role));
		const prior = this.declared.get(connectionId);
		if (prior !== undefined) return prior.length === roles.length && prior.every((role) => roles.includes(role));
		this.declared.set(connectionId, roles);
		return true;
	}

	/** The roles this connection explicitly declared, or undefined while it has declared none (no id = a stdio client). */
	rolesOf(connectionId: string | undefined): readonly string[] | undefined {
		return this.declared.get(roleConnection(connectionId));
	}

	/** Takes a declaration made elsewhere (the host, for a worker isolate) unless this connection already declared. */
	adopt(connectionId: string, roles: readonly string[]): void {
		if (!this.declared.has(connectionId)) this.declared.set(connectionId, [...roles]);
	}

	has(connectionId: string | undefined, role: string): boolean {
		return this.declared.get(roleConnection(connectionId))?.includes(role) ?? false;
	}

	release(connectionId: string): void {
		this.declared.delete(connectionId);
	}

	/** Forgets every connection, for a worker isolate whose session ends. */
	clear(): void {
		this.declared.clear();
	}
}
