import { HOST_OCCUPANCY_RECORD } from "./host-observe-request.ts";

/**
 * A socket host's answer to `watch_host_occupancy` (oh-my-openagent#14272): how many of its attached connections
 * still occupy it, sent to every watcher at once and again whenever the number changes. A connection occupies the
 * host while it holds a session, has an open or a command in flight, or has never held a session at all (an
 * ensure's attach hold, a client that has not opened yet). One whose sessions have all closed stops counting, so a
 * parent that keeps its shard connection after its last session does not keep a 0-session host alive.
 *
 * A watcher is the supervisor's observer link; while one is connected the host's own empty exit stays with the
 * supervisor (`watching`).
 */
export interface HostOccupancyWatchPorts {
	readonly connections: () => Iterable<string>;
	/** Attached by the occupancy rule: not an observer, not one of this host's own sessions (`host-client-occupancy.ts`). */
	readonly attached: (connection: string) => boolean;
	readonly holdsSessions: (connection: string) => boolean;
	readonly send: (connection: string, record: { readonly type: string; readonly holders: number }) => void;
}

export class HostOccupancyWatch {
	private readonly watchers = new Set<string>();
	private readonly inFlight = new Map<string, number>();
	/** Connections that held a session here at least once: only these stop counting once they hold nothing. */
	private readonly heldOnce = new Set<string>();
	private reported: number | undefined;
	private readonly ports: HostOccupancyWatchPorts;

	constructor(ports: HostOccupancyWatchPorts) {
		this.ports = ports;
	}

	get watching(): boolean {
		return this.watchers.size > 0;
	}

	watch(connection: string): void {
		this.watchers.add(connection);
		this.reported = this.holders();
		this.ports.send(connection, { type: HOST_OCCUPANCY_RECORD, holders: this.reported });
	}

	/** A command from `connection` started; it holds the host until `end`. */
	begin(connection: string): void {
		this.inFlight.set(connection, (this.inFlight.get(connection) ?? 0) + 1);
		this.refresh();
	}

	end(connection: string): void {
		if (this.ports.holdsSessions(connection)) this.heldOnce.add(connection);
		const left = (this.inFlight.get(connection) ?? 0) - 1;
		if (left > 0) this.inFlight.set(connection, left);
		else this.inFlight.delete(connection);
		this.refresh();
	}

	forget(connection: string): void {
		this.watchers.delete(connection);
		this.inFlight.delete(connection);
		this.heldOnce.delete(connection);
		this.refresh();
	}

	refresh(): void {
		if (this.watchers.size === 0) return;
		const holders = this.holders();
		if (holders === this.reported) return;
		this.reported = holders;
		for (const watcher of this.watchers) this.ports.send(watcher, { type: HOST_OCCUPANCY_RECORD, holders });
	}

	private holders(): number {
		let holders = 0;
		for (const connection of this.ports.connections()) {
			if (this.watchers.has(connection) || !this.ports.attached(connection)) continue;
			const holding = this.ports.holdsSessions(connection);
			if (holding) this.heldOnce.add(connection);
			if (holding || this.inFlight.has(connection) || !this.heldOnce.has(connection)) holders++;
		}
		return holders;
	}
}
