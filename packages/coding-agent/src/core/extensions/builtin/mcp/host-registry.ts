import type { ServerConnection } from "./connection.ts";
import { legacyMcpFormEligible } from "./elicitation.ts";
import { observe } from "./env-grants-store.ts";
import { effectiveGrantNames, type ProjectMcpAuthority } from "./project-skill-policy.ts";
import { SharedMcpConnection, type SharedMcpOptions } from "./shared-connection.ts";
import { sharedMcpKey } from "./sharing-policy.ts";

export { shareable } from "./sharing-policy.ts";

interface RegistryEntry {
	readonly connection: ServerConnection;
	readonly shareable: boolean;
	readonly owners: Map<object, number>;
}

export class HostMcpRegistryError extends Error {
	readonly code = "unknown_owner";
	readonly key: string;

	constructor(key: string) {
		super("Cannot detach an unknown MCP connection owner");
		this.name = "HostMcpRegistryError";
		this.key = key;
	}
}

/** Host-owned connection leases; standalone services construct their own registry. */
export class HostMcpRegistry {
	readonly #entries = new Map<string, Set<RegistryEntry>>();
	readonly #shared = new Map<string, SharedMcpConnection>();
	readonly #grantObservers = new Map<string, Promise<() => void>>();

	attachShared(key: string, owner: object, options: SharedMcpOptions): ServerConnection {
		const eligible = legacyMcpFormEligible(options.elicitationUiProvider, options.elicitationEnabled !== false);
		// Enforced pools observe live readiness; it must not remain frozen in a creation-time key.
		const formPolicy =
			options.elicitationUiProvider?.enforced?.() === true
				? `private:${options.elicitationEnabled !== false}`
				: `${eligible}:false`;
		const identity = `${sharedMcpKey(options, options.agentDir)}\0legacy-form:${formPolicy}`;
		let shared = this.#shared.get(identity);
		if (shared === undefined) {
			shared = new SharedMcpConnection(options, () => this.#shared.delete(identity));
			this.#shared.set(identity, shared);
		}
		const lease = shared.attach(options, owner, key);
		this.#watchProjectPolicy(options.projectPolicy);
		return lease;
	}

	attach(key: string, owner: object, factory: () => ServerConnection, canShare = false): ServerConnection {
		const entries = this.#entries.get(key);
		const owned = entries && [...entries].find((entry) => entry.owners.has(owner));
		if (owned) {
			owned.owners.set(owner, (owned.owners.get(owner) ?? 0) + 1);
			return owned.connection;
		}
		const shared = canShare && entries && [...entries].find((entry) => entry.shareable);
		if (shared) {
			shared.owners.set(owner, 1);
			return shared.connection;
		}
		const connection = factory();
		const entry: RegistryEntry = { connection, shareable: canShare, owners: new Map([[owner, 1]]) };
		if (entries) entries.add(entry);
		else this.#entries.set(key, new Set([entry]));
		this.#watchProjectPolicy(connection.projectPolicy);
		return connection;
	}
	*#projectConnections(): IterableIterator<ServerConnection> {
		for (const shared of this.#shared.values()) if (shared.connection.projectPolicy) yield shared.connection;
		for (const entries of this.#entries.values())
			for (const entry of entries) {
				if (entry.connection.projectPolicy) yield entry.connection;
			}
	}
	#watchProjectPolicy(policy: ProjectMcpAuthority | undefined): void {
		if (policy === undefined || this.#grantObservers.has(policy.storePath)) return;
		const stop = observe(policy.storePath, ({ snapshot, conservative }) => {
			const identities = new Set<string>();
			for (const connection of this.#projectConnections()) {
				const authority = connection.projectPolicy;
				if (authority === undefined || authority.storePath !== policy.storePath) continue;
				if (
					conservative ||
					JSON.stringify(connection.startedGrantNames) !==
						JSON.stringify(effectiveGrantNames(snapshot, authority.identity))
				)
					identities.add(authority.identity);
			}
			for (const identity of identities) {
				void this.invalidateIdentity(identity).catch(() => {
					for (const connection of this.#projectConnections()) {
						if (connection.declarationIdentity === identity) {
							connection.markDegraded(new Error("MCP grant invalidation failed; retry required"));
						}
					}
				});
			}
		});
		this.#grantObservers.set(policy.storePath, stop);
	}
	/** Closes the underlying transport now, not when its final lease goes idle. */
	async invalidateIdentity(digest: string): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const shared of this.#shared.values()) {
			if (shared.connection.declarationIdentity === digest) pending.push(shared.invalidate());
		}
		for (const entries of this.#entries.values())
			for (const entry of entries) {
				if (entry.connection.declarationIdentity === digest) pending.push(entry.connection.bumpGeneration());
			}
		await Promise.all(pending);
	}

	async detach(key: string, owner: object): Promise<void> {
		for (const shared of this.#shared.values()) {
			const lease = [...shared.leases].find((item) => item.key === key && item.owner === owner);
			if (lease === undefined) continue;
			await lease.dispose();
			return;
		}
		const entries = this.#entries.get(key);
		if (!entries) throw new HostMcpRegistryError(key);
		for (const entry of entries) {
			const count = entry.owners.get(owner);
			if (count === undefined) continue;
			if (count > 1) {
				entry.owners.set(owner, count - 1);
				return;
			}
			entry.owners.delete(owner);
			if (entry.owners.size > 0) return;
			entries.delete(entry);
			if (entries.size === 0) this.#entries.delete(key);
			await entry.connection.dispose();
			return;
		}
		throw new HostMcpRegistryError(key);
	}

	*forEachOwner(key: string): IterableIterator<object> {
		for (const entry of this.#entries.get(key) ?? []) yield* entry.owners.keys();
		for (const shared of this.#shared.values()) {
			for (const lease of shared.leases) if (lease.key === key) yield lease.owner;
		}
	}

	async dispose(): Promise<void> {
		const observers = [...this.#grantObservers.values()];
		this.#grantObservers.clear();
		await Promise.all(observers.map(async (stop) => (await stop)()));
		const connections = [...this.#entries.values()].flatMap((entries) =>
			[...entries].map((entry) => entry.connection),
		);
		this.#entries.clear();
		await Promise.all([
			...connections.map((connection) => connection.dispose()),
			...[...this.#shared.values()].map((shared) => shared.dispose()),
		]);
	}

	size(): number {
		let count = this.#shared.size;
		for (const entries of this.#entries.values()) count += entries.size;
		return count;
	}
}
