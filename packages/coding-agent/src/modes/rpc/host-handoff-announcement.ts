/**
 * The handoff announcement of one host generation (senpi#2285, senpi#3816 review). The sealed internal hop
 * authenticates before the host can register a connection, so a connection that reached the listener before the drain
 * began can finish authenticating after the announcement was broadcast. It still gets that one record, then a clean
 * close; a connection that arrives after the drain began is refused as before.
 */
import type { Duplex } from "node:stream";
import type { RpcHostSupersededEvent } from "./rpc-host-lifecycle-types.ts";

export class HandoffAnnouncement {
	private record: Promise<RpcHostSupersededEvent | undefined> | undefined;

	/** Builds the record once the successor is known; undefined (logged) when the endpoint could not be checked. */
	begin(
		superseded: Promise<boolean>,
		identity: { readonly instanceId: string; readonly generation: number },
		publicSocket: string,
		log: (message: string) => void,
	): Promise<RpcHostSupersededEvent | undefined> {
		this.record = superseded.then(
			(replaced): RpcHostSupersededEvent => ({
				type: "host_superseded",
				...identity,
				successor: replaced ? { socket: publicSocket } : null,
			}),
			(cause: unknown) => {
				log(`handoff announcement failed: ${String(cause)}`);
				return undefined;
			},
		);
		return this.record;
	}

	/** Takes a connection that finished authenticating during the drain; false when it must be refused instead. */
	deliverLate(stream: Duplex, arrivedBeforeDrain: boolean): boolean {
		const record = this.record;
		if (!arrivedBeforeDrain || record === undefined) return false;
		void record.then((announced) =>
			announced === undefined ? stream.destroy() : stream.end(`${JSON.stringify(announced)}\n`),
		);
		return true;
	}
}
