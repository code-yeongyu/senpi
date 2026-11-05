/**
 * The supervisor's view of its public-socket clients, split by what they mean for idle exit. A socket
 * host applies the same view to its own connections for its empty-exit window.
 *
 * A client is UNCLASSIFIED until its first request line arrives, an OBSERVER while every line it has
 * sent is an observing read (`host-observe-request.ts`), and ATTACHED from the first line that is
 * anything else - or from a first line too long to be a read. Only attached clients are occupancy.
 * A client whose first such line names this host's own generation as its origin is DEPENDENT
 * instead (`host-observe-request.ts`): one of the host's own sessions, which never holds it open.
 * An unclassified client neither counts nor lets the host exit: its first line may be the readiness
 * probe of an ensure that is about to open a session.
 * An observer that takes a hold (`hold_host: true` on an observing read, senpi#5626) is HELD: it counts as
 * occupancy, and taking the hold resets the idle window, until it releases (`hold_host: false`) or leaves.
 */
import type { Duplex } from "node:stream";
import { isObservingRequest, observingHoldChange, requestOriginHostInstance } from "./host-observe-request.ts";

const MAX_CLASSIFIED_LINE_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export class ClientOccupancy {
	private readonly clients = new Set<Duplex>();
	private readonly observers = new Set<Duplex>();
	private readonly attached = new Set<Duplex>();
	private readonly held = new Set<Duplex>();
	private readonly dependents = new Set<Duplex>();
	private readonly onAttach: () => void;
	private readonly ownInstance: string | undefined;
	private closed = false;

	constructor(onAttach: () => void, ownInstance?: string) {
		this.onAttach = onAttach;
		this.ownInstance = ownInstance;
	}

	/** Occupancy: attached clients plus observers holding the host. */
	get attachedCount(): number {
		return this.attached.size + this.held.size;
	}

	get unclassifiedCount(): number {
		return this.clients.size - this.observers.size - this.attached.size - this.dependents.size;
	}

	admit(client: Duplex): boolean {
		if (this.closed) {
			client.destroy();
			return false;
		}
		this.clients.add(client);
		let pending = Buffer.alloc(0);
		const attach = (): void => {
			client.off("data", classify);
			pending = Buffer.alloc(0);
			this.observers.delete(client);
			this.held.delete(client);
			this.attached.add(client);
			this.onAttach();
		};
		const depend = (): void => {
			client.off("data", classify);
			pending = Buffer.alloc(0);
			this.observers.delete(client);
			this.held.delete(client);
			this.dependents.add(client);
		};
		const classify = (chunk: Buffer): void => {
			pending = Buffer.concat([pending, chunk]);
			for (let newline = pending.indexOf(NEWLINE); newline !== -1; newline = pending.indexOf(NEWLINE)) {
				const line = pending.subarray(0, newline).toString("utf8");
				pending = pending.subarray(newline + 1);
				if (!isObservingRequest(line)) {
					if (this.ownInstance !== undefined && requestOriginHostInstance(line) === this.ownInstance) depend();
					else attach();
					return;
				}
				this.observers.add(client);
				const hold = observingHoldChange(line);
				if (hold === true && !this.held.has(client)) {
					this.held.add(client);
					this.onAttach();
				} else if (hold === false) this.held.delete(client);
			}
			if (pending.length > MAX_CLASSIFIED_LINE_BYTES) attach();
		};
		client.on("data", classify);
		return true;
	}

	/** Returns whether this peer left without ever proving it was an observing read. */
	release(client: Duplex): boolean {
		const unclassified =
			this.clients.has(client) &&
			!this.observers.has(client) &&
			!this.attached.has(client) &&
			!this.dependents.has(client);
		this.clients.delete(client);
		this.observers.delete(client);
		this.attached.delete(client);
		this.held.delete(client);
		this.dependents.delete(client);
		return unclassified;
	}

	destroyAll(): void {
		this.closed = true;
		for (const client of this.clients) client.destroy();
	}
}
