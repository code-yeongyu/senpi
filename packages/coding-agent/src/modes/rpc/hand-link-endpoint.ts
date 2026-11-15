/**
 * The RPC host's tool-relay mode (R3 `hand_link`, senpi#5924): a hosted brain reaches this machine through the relay,
 * and each packet batch arrives as one `hand_link` record. Every hosted session gets its own link: a reference
 * transport whose carrier is the batches themselves, serving the same hand engine as `--hand` (`createHandEndpoint`).
 *
 * - The sender is the delegated connection's principal, never a frame field; it is the owner every epoch check sees.
 * - `loop.generation` is the session's owner epoch. A newer generation replaces the link and tears down the old one's
 *   scopes; an older one is refused, and so is a second sender or loop at the generation already admitted. A link
 *   that ended (a malformed batch) reopens only at a higher generation: its transport state is gone.
 * - One epoch fence for the whole host: a scope's floor is raised only by the owner of the session that first used
 *   that scope; a batch on a scope lane another session holds ends the link, and a loop-hook call naming one fails.
 * - A batch is answered at once with what the hand has queued for the brain; a tool still running answers in a later
 *   batch, so a following batch (an abort among them) never waits behind it. A frame over the part size goes as
 *   `data_part` packets, and an answer holds at most one record's worth: the rest waits for the next batch.
 * - Packets are read in full before any reaches the hand, parts joined across batches; one that does not read (a
 *   count conflict among them) ends the session's link.
 */
import {
	createHandEpochFence,
	createReliableTransport,
	HAND_CONTROL_LANE,
	type HandEpochFenceOptions,
	type ReferencePacket,
	type TransportSide,
} from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import { createHandEndpoint, HAND_LOOP_HOOK_LANE, type HandEndpoint } from "../hand/hand-endpoint.ts";
import {
	createHandPacketReader,
	encodeHandPackets,
	type HandPacketReader,
	type HandWirePacket,
} from "../hand/hand-packet-codec.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { createLooplessHand, type LooplessHand } from "./remote-executor-scope.ts";
import { MAX_RPC_MESSAGE_CHARACTERS } from "./rpc-input-validation.ts";

export interface HandLinkBatch {
	readonly session: string;
	readonly loop: { readonly id: string; readonly generation: number };
	/** The wire packets as the record carries them. */
	readonly packets: readonly unknown[];
}

export type HandLinkRefusal =
	| "hand_link_malformed"
	| "hand_link_superseded"
	| "hand_link_generation_taken"
	| "hand_link_scope_taken"
	| "hand_link_closed";

export type HandLinkAnswer =
	| { readonly kind: "packets"; readonly packets: readonly HandWirePacket[] }
	| { readonly kind: "refused"; readonly reason: HandLinkRefusal };

export interface HandLinkEndpoint {
	link(sender: string, batch: HandLinkBatch): Promise<HandLinkAnswer>;
	close(): Promise<void>;
}

export interface HandLinkEndpointOptions {
	/** The machine's hand, opened on the first link; its scopes are shared by every session's link. */
	readonly openHand: () => Pick<LooplessHand, "openScope" | "loopHooks" | "close">;
	/** Where the epoch floors persist (the hand's store); without it they live as long as this process. */
	readonly durable?: HandEpochFenceOptions["durable"];
	readonly report: (message: string) => void;
}

interface Link {
	readonly owner: string;
	readonly loopId: string;
	readonly generation: number;
	readonly transport: TransportSide;
	readonly endpoint: HandEndpoint;
	readonly read: HandPacketReader;
	/** What the hand queued for the brain and no answer took yet; one entry per wire packet and per lane's ACK. */
	readonly outbox: Map<string, HandWirePacket>;
}

const refused = (reason: HandLinkRefusal): HandLinkAnswer => ({ kind: "refused", reason });

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

/** Takes the outbox in order up to one record's worth (always at least one packet); the rest waits for the next batch. */
function takeAnswer(outbox: Map<string, HandWirePacket>): HandWirePacket[] {
	const packets: HandWirePacket[] = [];
	let size = 0;
	for (const [key, packet] of outbox) {
		size += JSON.stringify(packet).length;
		if (packets.length > 0 && size > MAX_RPC_MESSAGE_CHARACTERS) break;
		packets.push(packet);
		outbox.delete(key);
	}
	return packets;
}

/** Every packet read before any is delivered; `undefined` when one does not read or is over the record bound. */
function readAll(read: HandPacketReader, wire: readonly unknown[]): ReferencePacket[] | undefined {
	const packets: ReferencePacket[] = [];
	for (const item of wire) {
		if (JSON.stringify(item).length > MAX_RPC_MESSAGE_CHARACTERS) return undefined;
		const packet = read(item);
		if (packet === undefined) return undefined;
		if (packet !== null) packets.push(packet);
	}
	return packets;
}

function scopeIdOf(payload: JsonValue): string | undefined {
	const scope: unknown = typeof payload === "object" && payload !== null ? Reflect.get(payload, "scope") : undefined;
	const id: unknown = typeof scope === "object" && scope !== null ? Reflect.get(scope, "id") : undefined;
	return typeof id === "string" ? id : undefined;
}

/** The RPC host's endpoint: the machine's hand on the host's own configuration, home of its loop hooks like `--hand`. */
export function createHostHandLink(configuration: CliRuntimeConfiguration): HandLinkEndpoint {
	return createHandLinkEndpoint({
		openHand: () => createLooplessHand(configuration, { twoSidedHome: "hand" }),
		report: (message) => void process.stderr.write(`senpi hand_link: ${message}\n`),
	});
}

export function createHandLinkEndpoint(options: HandLinkEndpointOptions): HandLinkEndpoint {
	const { report } = options;
	const links = new Map<string, Link>();
	/** The lowest generation each session may still open, kept after its link ends so an older one stays refused. */
	const lowest = new Map<string, number>();
	/** Which session each scope belongs to, for the life of the process (as long as its floor). */
	const scopeSessions = new Map<string, string>();
	const queues = new Map<string, Promise<unknown>>();
	let hand: ReturnType<HandLinkEndpointOptions["openHand"]> | undefined;
	let closed = false;

	const fence = createHandEpochFence({
		ownerOf: (scope) => {
			const session = scopeSessions.get(scope);
			return session === undefined ? undefined : links.get(session)?.owner;
		},
		...(options.durable === undefined ? {} : { durable: options.durable }),
	});
	const claim = (scope: string, session: string): boolean => {
		const holder = scopeSessions.get(scope);
		if (holder === undefined) scopeSessions.set(scope, session);
		return holder === undefined || holder === session;
	};
	const end = async (session: string): Promise<void> => {
		const link = links.get(session);
		if (link === undefined) return;
		links.delete(session);
		await link.endpoint.close();
	};
	const refuseAndEnd = async (batch: HandLinkBatch, reason: HandLinkRefusal): Promise<HandLinkAnswer> => {
		lowest.set(batch.session, batch.loop.generation + 1);
		await end(batch.session);
		return refused(reason);
	};

	const open = (sender: string, batch: HandLinkBatch): Link => {
		hand ??= options.openHand();
		const { openScope, loopHooks } = hand;
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
			openScope,
			loopHooks: (event, payload) => {
				const scope = scopeIdOf(payload);
				if (scope !== undefined && !claim(scope, batch.session))
					return Promise.reject(new Error(`hand_link_scope_taken: scope ${JSON.stringify(scope)}`));
				return loopHooks(event, payload);
			},
			authority: { kind: "relayed", peer: sender },
			fence,
			report,
		});
		return {
			owner: sender,
			loopId: batch.loop.id,
			generation: batch.loop.generation,
			transport,
			endpoint,
			read: createHandPacketReader(),
			outbox,
		};
	};

	const linkFor = async (sender: string, batch: HandLinkBatch): Promise<Link | HandLinkAnswer> => {
		const { session, loop } = batch;
		if (loop.generation < (lowest.get(session) ?? 1)) return refused("hand_link_superseded");
		const current = links.get(session);
		if (current !== undefined && current.generation === loop.generation)
			return current.owner === sender && current.loopId === loop.id
				? current
				: refused("hand_link_generation_taken");
		// A newer generation supersedes the session's link: its running calls are aborted and its scopes disposed.
		await end(session);
		lowest.set(session, loop.generation);
		const link = open(sender, batch);
		links.set(session, link);
		return link;
	};

	const handle = async (sender: string, batch: HandLinkBatch): Promise<HandLinkAnswer> => {
		if (closed) return refused("hand_link_closed");
		const link = await linkFor(sender, batch);
		if (!("transport" in link)) return link;
		const packets = readAll(link.read, batch.packets);
		const scopes = packets?.flatMap((packet) =>
			packet.kind === "data" && packet.lane !== HAND_CONTROL_LANE && packet.lane !== HAND_LOOP_HOOK_LANE
				? [packet.lane]
				: [],
		);
		if (packets === undefined || scopes === undefined) return refuseAndEnd(batch, "hand_link_malformed");
		if (!scopes.every((scope) => claim(scope, batch.session))) return refuseAndEnd(batch, "hand_link_scope_taken");
		for (const packet of packets) link.transport.message(packet);
		// One turn of the event loop lets the frames this batch delivered be acknowledged and answered now; a call
		// still running answers in a later batch.
		await new Promise<void>((resolve) => setImmediate(resolve));
		return { kind: "packets", packets: takeAnswer(link.outbox) };
	};

	return {
		link(sender, batch) {
			const previous = queues.get(batch.session) ?? Promise.resolve();
			const next = previous.then(() => handle(sender, batch));
			const settled = next.catch(() => undefined);
			queues.set(batch.session, settled);
			void settled.then(() => {
				if (queues.get(batch.session) === settled) queues.delete(batch.session);
			});
			return next;
		},
		async close() {
			closed = true;
			await Promise.allSettled([...links.keys()].map((session) => end(session)));
			await hand?.close();
		},
	};
}
