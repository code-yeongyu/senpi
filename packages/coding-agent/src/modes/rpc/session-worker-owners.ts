import { randomUUID } from "node:crypto";
import {
	carriesExtensionOwner,
	ExtensionOwner,
	type ExtensionOwnerIdentity,
	type ExtensionOwnerWire,
} from "./extension-owner.ts";
import type { SessionConnectionContext } from "./session-connection-context.ts";

const identityKey = (identity: ExtensionOwnerIdentity): string =>
	`${identity.ownerId}\u0000${identity.bindingGeneration}`;

/**
 * Host half of a worker binding's extension owners (#4728). Gates are captured at ingress, before the
 * command's first await, and retired atomically before the isolate hears about it.
 */
export class WorkerOwnerGates {
	private generation = randomUUID();
	private readonly issued = new Map<string, Set<ExtensionOwner>>();

	capture(
		context: SessionConnectionContext,
		connection: string | undefined,
		command: object,
	): ExtensionOwnerWire | undefined {
		const transport = context.transport;
		if (connection === undefined || transport === undefined || !carriesExtensionOwner(command)) return undefined;
		let owner = transport.capture(this.generation);
		// The isolate retires a generation by replacing its session; the next request opens a new one.
		if (owner.retired) {
			this.generation = randomUUID();
			owner = transport.capture(this.generation);
		}
		const owners = this.issued.get(connection) ?? new Set<ExtensionOwner>();
		owners.add(owner);
		this.issued.set(connection, owners);
		return owner.wire;
	}

	/**
	 * `connection` left this session. Only the incarnation that left is retired: a gate for a transport now
	 * registered under the same routing string with a different owner was already retired with its transport.
	 */
	detach(context: SessionConnectionContext, connection: string): ExtensionOwnerIdentity[] {
		const owners = this.issued.get(connection);
		if (!owners) return [];
		this.issued.delete(connection);
		const current = context.transportOf(connection);
		const kept = new Set<ExtensionOwner>();
		const retired: ExtensionOwnerIdentity[] = [];
		for (const owner of owners) {
			if (current !== undefined && current.ownerId !== owner.wire.ownerId && !owner.retired) kept.add(owner);
			else {
				owner.retire();
				retired.push({ ownerId: owner.wire.ownerId, bindingGeneration: owner.wire.bindingGeneration });
			}
		}
		if (kept.size > 0) this.issued.set(connection, kept);
		return retired;
	}

	retireAll(): ExtensionOwnerIdentity[] {
		const retired: ExtensionOwnerIdentity[] = [];
		for (const owners of this.issued.values())
			for (const owner of owners) {
				owner.retire();
				retired.push({ ownerId: owner.wire.ownerId, bindingGeneration: owner.wire.bindingGeneration });
			}
		this.issued.clear();
		this.generation = randomUUID();
		return retired;
	}
}

/** Isolate half: one owner object per issued gate, sharing the host's retirement word. */
export class IssuedWorkerOwners {
	private readonly owners = new Map<string, ExtensionOwner>();

	adopt(wire: ExtensionOwnerWire): ExtensionOwner {
		const key = identityKey(wire);
		const existing = this.owners.get(key);
		if (existing) return existing;
		const owner = new ExtensionOwner(wire);
		this.owners.set(key, owner);
		return owner;
	}

	/** Exact identities only: a late notice for one incarnation never reaches another. */
	retire(identities: readonly ExtensionOwnerIdentity[]): void {
		for (const identity of identities) {
			const key = identityKey(identity);
			this.owners.get(key)?.retire();
			this.owners.delete(key);
		}
	}
}
