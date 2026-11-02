import { createManualTimers, type ManualTimers } from "../../durable/testing/manual-timers.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { type CarrierLink, createInProcessNetwork } from "../in-process-carrier.ts";
import { localEndpoint } from "../local-endpoint.ts";
import type { CarrierSide, TransportClock, TransportSide } from "../transport.ts";

/** What a conformance host's decoder reports about one carrier message; data and ACK sequence numbers start at 1. */
export type WireView =
	| { readonly kind: "data" | "ack"; readonly lane: string; readonly seq: number }
	| { readonly kind: "other" };

/** What a host provides to the TRANSPORT, MULTI-LANE/FAIR and FAULT-TRANSPORT cases. */
export interface TransportConformanceAdapter {
	/** A new transport endpoint scheduling on `clock`; the cases attach two of them through an in-process carrier. */
	createSide(clock: TransportClock): TransportSide;
	/** Reads the lane and sequence number of a carrier message, so the cases can check resume from the last ACK. */
	decode(message: unknown): WireView;
}

export interface TransportCaseAdapters {
	readonly transport: TransportConformanceAdapter;
	/** The platform whose local endpoint naming the link uses (`win32` names a pipe). */
	readonly platform: string;
}

/** A fault on the carrier path: it wraps each side's view of the carrier and may drive the link. */
export interface CarrierFault {
	wrap(side: CarrierSide): CarrierSide;
	start(link: CarrierLink): void;
}

const TICK_MS = 5;
const DRAIN_TURNS = 32;

const drainMicrotasks = async (): Promise<void> => {
	for (let turn = 0; turn < DRAIN_TURNS; turn++) await Promise.resolve();
};

function tap(side: TransportSide, decode: (message: unknown) => WireView, violations: string[]): CarrierSide {
	const acked = new Map<string, number>();
	return {
		attached: (connection) =>
			side.attached({
				send: (message) => {
					const view = decode(message);
					if (view.kind === "data" && view.seq <= (acked.get(view.lane) ?? 0)) {
						violations.push(`${view.lane}#${view.seq} sent again after its ACK`);
					}
					return connection.send(message);
				},
				close: () => connection.close(),
			}),
		message: (message) => {
			const view = decode(message);
			if (view.kind === "ack") acked.set(view.lane, Math.max(acked.get(view.lane) ?? 0, view.seq));
			side.message(message);
		},
		writable: () => side.writable(),
		detached: () => side.detached(),
	};
}

export interface TestLink {
	readonly sender: TransportSide;
	readonly link: CarrierLink;
	readonly timers: ManualTimers;
	/** Global delivery order, as `lane:n`. */
	readonly log: readonly string[];
	/** Every data frame sent again after the sender had seen its ACK. */
	readonly violations: readonly string[];
	send(lane: string, n: number): Promise<void>;
	delivered(lane: string): readonly number[];
	/** Holds the receiver on `lane` (from its next frame) until the returned release is called. */
	gate(lane: string): () => void;
	/** Makes the receiver take `ms` of transport time for each frame on `lane` (from its next frame). */
	pace(lane: string, ms: number): void;
	runUntil(done: () => boolean, what: string, budgetMs?: number): Promise<void>;
	/** Advances transport time until every promise settles; a rejection fails the case. */
	awaitAll(promises: readonly Promise<unknown>[], what: string): Promise<void>;
	advance(ms: number): Promise<void>;
}

export function openLink(adapters: TransportCaseAdapters, fault?: (timers: ManualTimers) => CarrierFault): TestLink {
	const timers = createManualTimers(0);
	const network = createInProcessNetwork({ schedule: (deliver) => void timers.setTimer(deliver, 0) });
	const sender = adapters.transport.createSide(timers);
	const receiver = adapters.transport.createSide(timers);
	const violations: string[] = [];
	const log: string[] = [];
	const received = new Map<string, number[]>();
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const paces = new Map<string, number>();
	const installed = fault?.(timers);
	const outer = (side: TransportSide): CarrierSide => {
		const tapped = tap(side, (message) => adapters.transport.decode(message), violations);
		return installed === undefined ? tapped : installed.wrap(tapped);
	};
	const endpoint = localEndpoint(adapters.platform, "transport-conformance", "/run/senpi-conformance");
	network.listen(endpoint, outer(receiver));
	const link = network.dial(endpoint, outer(sender));
	const decoder = new TextDecoder();
	receiver.onFrame(async (frame) => {
		await gates.get(frame.lane)?.promise;
		const paceMs = paces.get(frame.lane);
		if (paceMs !== undefined) await new Promise<void>((resolve) => void timers.setTimer(resolve, paceMs));
		const n = Number(decoder.decode(frame.payload));
		received.set(frame.lane, [...(received.get(frame.lane) ?? []), n]);
		log.push(`${frame.lane}:${n}`);
	});
	link.connect();
	installed?.start(link);
	const advance = async (ms: number): Promise<void> => {
		const end = timers.now() + ms;
		while (timers.now() < end) {
			await timers.advanceTo(Math.min(end, timers.now() + TICK_MS));
			await drainMicrotasks();
		}
	};
	const encoder = new TextEncoder();
	const runUntil = async (done: () => boolean, what: string, budgetMs = 120_000): Promise<void> => {
		const end = timers.now() + budgetMs;
		while (!done()) {
			if (timers.now() >= end) {
				const counts = [...received].map(([lane, ns]) => `${lane}=${ns.length}`).join(" ");
				throw new Error(`${what}: not reached within ${budgetMs} ms of transport time (delivered ${counts})`);
			}
			await advance(TICK_MS);
		}
	};
	return {
		sender,
		link,
		timers,
		log,
		violations,
		send: (lane, n) => sender.send(lane, encoder.encode(String(n))),
		delivered: (lane) => received.get(lane) ?? [],
		gate(lane) {
			const gate = Promise.withResolvers<void>();
			gates.set(lane, gate);
			return () => {
				gates.delete(lane);
				gate.resolve();
			};
		},
		pace(lane, ms) {
			paces.set(lane, ms);
		},
		runUntil,
		async awaitAll(promises, what) {
			let settled = 0;
			let failure: unknown;
			for (const promise of promises) {
				promise.then(
					() => void (settled += 1),
					(error: unknown) => {
						settled += 1;
						failure ??= error;
					},
				);
			}
			await runUntil(() => settled === promises.length, `${what}: every send settled`);
			if (failure !== undefined) throw failure;
		},
		advance,
	};
}

export const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Every lane got exactly 1..count, in order, once; nothing is left unacknowledged; nothing acknowledged was re-sent. */
export function expectExactDelivery(link: TestLink, counts: Readonly<Record<string, number>>, what: string): void {
	const lanes = Object.keys(counts);
	expectEqual(
		lanes.map((lane) => link.delivered(lane)),
		lanes.map((lane) => range(1, counts[lane] ?? 0)),
		`${what}: each lane delivered in order, once`,
	);
	expectEqual(
		lanes.map((lane) => link.sender.inFlight(lane)),
		lanes.map(() => 0),
		`${what}: nothing in flight`,
	);
	expectEqual(link.violations, [], `${what}: resume starts after each lane's last ACK`);
}

export const allDelivered = (link: TestLink, counts: Readonly<Record<string, number>>) => () =>
	Object.entries(counts).every(([lane, count]) => link.delivered(lane).length >= count);
