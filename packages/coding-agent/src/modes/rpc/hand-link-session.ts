/**
 * One hosted session's link on this daemon (R3 `hand_link`): a reference transport whose carrier is the batches
 * themselves, serving the same hand engine as `--hand` (`createHandEndpoint`), with the reader that joins `data_part`
 * packets across batches and the outbox that answers them. `instance` names this link: it is minted here, so it is new
 * whenever the daemon opens the session's link again (after a restart, or for a new generation).
 */
import {
	createReliableTransport,
	HAND_CONTROL_LANE,
	type HandEpochFence,
	type ReferencePacket,
} from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createHandEndpoint, HAND_LOOP_HOOK_LANE } from "../hand/hand-endpoint.ts";
import { createHandPacketReader, encodeHandPackets, type HandWirePacket } from "../hand/hand-packet-codec.ts";
import type { LooplessHand } from "./remote-executor-scope.ts";
import { MAX_RPC_MESSAGE_CHARACTERS } from "./rpc-input-validation.ts";
import type { ScopeClaim } from "./hand-link-state.ts";

export interface SessionLinkOptions {
	readonly hand: Pick<LooplessHand, "openScope" | "loopHooks">;
	readonly fence: HandEpochFence;
	/** Binds a scope a loop-hook call names to this session; `false` when another session holds it. */
	readonly claimScope: (scope: string) => Promise<ScopeClaim>;
	readonly sender: string;
	readonly generation: number;
	readonly report: (message: string) => void;
}

export interface SessionLink {
	readonly generation: number;
	readonly instance: string;
	/** A batch's wire packets, read in full before any is delivered; `undefined` when one does not read. */
	read(wire: readonly unknown[]): ReferencePacket[] | undefined;
	deliver(packets: readonly ReferencePacket[]): void;
	/** What the hand queued, up to one record's worth, and whether more is still queued. */
	answer(): { readonly packets: readonly HandWirePacket[]; readonly more: boolean };
	/** Aborts the link's running calls, disposes its scopes and closes its transport. */
	close(): Promise<void>;
}

const outboxKey = (packet: HandWirePacket): string => {
	switch (packet.kind) {
		case "ack":
			return `ack:${packet.lane}`;
		case "data":
			return `data:${packet.lane}:${packet.seq}`;
		case "data_part":
			return `part:${packet.lane}:${packet.seq}:${packet.index}`;
	}
};

function scopeIdOf(payload: JsonValue): string | undefined {
	const scope: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "scope") : undefined;
	const id: unknown = typeof scope === "object" && scope !== null ? Reflect.get(scope, "id") : undefined;
	return typeof id === "string" ? id : undefined;
}

/** The scope lanes `packets` carry data on: every lane but the hand's control lane and the loop-hook lane. */
export function scopeLanes(packets: readonly ReferencePacket[]): string[] {
	const lanes = packets.flatMap((packet) =>
		packet.kind === "data" && packet.lane !== HAND_CONTROL_LANE && packet.lane !== HAND_LOOP_HOOK_LANE
			? [packet.lane]
			: [],
	);
	return [...new Set(lanes)];
}

export function openSessionLink(options: SessionLinkOptions): SessionLink {
	const { hand, report } = options;
	const outbox = new Map<string, HandWirePacket>();
	const transport = createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => report(`frame handler failed: ${String(error)}`),
	});
	transport.attached({
		// A re-sent frame replaces its earlier copy, so a brain that polls slowly never collects duplicates.
		send: (message) => {
			for (const packet of encodeHandPackets(message) ?? []) outbox.set(outboxKey(packet), packet);
			return true;
		},
		close: () => outbox.clear(),
	});
	const endpoint = createHandEndpoint({
		transport,
		openScope: hand.openScope,
		loopHooks: async (event, payload) => {
			const scope = scopeIdOf(payload);
			const claim = scope === undefined ? "held" : await options.claimScope(scope);
			if (claim !== "held") throw new Error(`hand_link_scope_${claim}: scope ${JSON.stringify(scope)}`);
			return hand.loopHooks(event, payload);
		},
		authority: { kind: "relayed", peer: options.sender },
		fence: options.fence,
		report,
	});
	const reader = createHandPacketReader();
	return {
		generation: options.generation,
		instance: crypto.randomUUID(),
		read(wire) {
			const packets: ReferencePacket[] = [];
			for (const item of wire) {
				if (JSON.stringify(item).length > MAX_RPC_MESSAGE_CHARACTERS) return undefined;
				const packet = reader(item);
				if (packet === undefined) return undefined;
				if (packet !== null) packets.push(packet);
			}
			return packets;
		},
		deliver(packets) {
			for (const packet of packets) transport.message(packet);
		},
		answer() {
			const packets: HandWirePacket[] = [];
			let size = 0;
			for (const [key, packet] of outbox) {
				size += JSON.stringify(packet).length;
				if (packets.length > 0 && size > MAX_RPC_MESSAGE_CHARACTERS) break;
				packets.push(packet);
				outbox.delete(key);
			}
			return { packets, more: outbox.size > 0 };
		},
		close: () => endpoint.close(),
	};
}
