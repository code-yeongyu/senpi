import type { CaseImplementation } from "../../conformance/runner.ts";
import { createCarrierFault, type FaultStats } from "./fault-transport.ts";
import {
	allDelivered,
	type CarrierFault,
	expectExactDelivery,
	openLink,
	range,
	type TransportCaseAdapters,
	type WireView,
} from "./transport-harness.ts";

type MultiCase = CaseImplementation<TransportCaseAdapters>;

const manyLanes: MultiCase = async (adapters) => {
	const link = openLink(adapters);
	const lanes = range(1, 8).map((n) => `scope-${n}`);
	const counts = Object.fromEntries(lanes.map((lane) => [lane, 25]));
	const sends = range(1, 25).flatMap((n) => lanes.map((lane) => link.send(lane, n)));
	await link.runUntil(allDelivered(link, counts), "MULTI-LANE-01 every scope delivered");
	await link.awaitAll(sends, "MULTI-LANE-01");
	await link.advance(1000);
	expectExactDelivery(link, counts, "MULTI-LANE-01");
	const lanesInLog = link.log.map((entry) => entry.slice(0, entry.indexOf(":")));
	for (const lane of lanes) {
		const first = lanesInLog.indexOf(lane);
		const lastOfOthers = Math.min(
			...lanes.filter((other) => other !== lane).map((other) => lanesInLog.lastIndexOf(other)),
		);
		if (first > lastOfOthers) throw new Error(`MULTI-LANE-01: ${lane} started only after another scope had finished`);
	}
};

const stalledLaneDoesNotHoldOthers = async (adapters: TransportCaseAdapters): Promise<void> => {
	const link = openLink(adapters);
	const release = link.gate("A");
	const aSends = range(1, 100).map((n) => link.send("A", n));
	const bSends = range(1, 10).map((n) => link.send("B", n));
	await link.runUntil(
		allDelivered(link, { B: 10 }),
		"MULTI-FAIR-01 B delivered while A's receiver is stalled",
		20_000,
	);
	await link.awaitAll(bSends, "MULTI-FAIR-01 B");
	if (link.delivered("A").length > 0) throw new Error("MULTI-FAIR-01: A delivered through a stalled receiver");
	release();
	await link.runUntil(allDelivered(link, { A: 100 }), "MULTI-FAIR-01 A delivered after release");
	await link.awaitAll(aSends, "MULTI-FAIR-01 A");
	await link.advance(1000);
	expectExactDelivery(link, { A: 100, B: 10 }, "MULTI-FAIR-01 stalled lane");
};

const MAX_A_FRAMES_BEFORE_B = 4;

const longLaneDoesNotStarveAnother = async (adapters: TransportCaseAdapters): Promise<void> => {
	const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
	const link = openLink(adapters, createCarrierFault("slow", stats));
	const aSends = range(1, 300).map((n) => link.send("A", n));
	await link.runUntil(() => link.delivered("A").length >= 20, "MULTI-FAIR-01 A's long lane under way");
	const before = link.delivered("A").length;
	const bSend = link.send("B", 1);
	await link.runUntil(allDelivered(link, { B: 1 }), "MULTI-FAIR-01 B delivered behind A's long lane");
	const aheadOfB = link.delivered("A").length - before;
	if (aheadOfB > MAX_A_FRAMES_BEFORE_B) {
		throw new Error(
			`MULTI-FAIR-01: ${aheadOfB} of A's frames went ahead of B's one frame (at most ${MAX_A_FRAMES_BEFORE_B})`,
		);
	}
	await link.runUntil(allDelivered(link, { A: 300 }), "MULTI-FAIR-01 A's long lane delivered", 600_000);
	await link.awaitAll([...aSends, bSend], "MULTI-FAIR-01 long lane");
	await link.advance(1000);
	expectExactDelivery(link, { A: 300, B: 1 }, "MULTI-FAIR-01 long lane");
	if (stats.refused === 0) throw new Error("MULTI-FAIR-01: the slow carrier never pushed back");
};

const fairness: MultiCase = async (adapters) => {
	await stalledLaneDoesNotHoldOthers(adapters);
	await longLaneDoesNotStarveAnother(adapters);
};

/** Loses the first data message of `lane`#`seq` on the carrier, once; every other message passes. */
function loseOnce(decode: (message: unknown) => WireView, lane: string, seq: number, stats: FaultStats): CarrierFault {
	return {
		wrap: (side) => ({
			attached: (connection) =>
				side.attached({
					send: (message) => {
						const view = decode(message);
						if (stats.lost === 0 && view.kind === "data" && view.lane === lane && view.seq === seq) {
							stats.lost += 1;
							return true;
						}
						return connection.send(message);
					},
					close: () => connection.close(),
				}),
			message: (message) => side.message(message),
			writable: () => side.writable(),
			detached: () => side.detached(),
		}),
		start: () => {},
	};
}

const LONG_LANE_FRAMES = 400;
const LONG_LANE_PACE_MS = 10;

/**
 * B's only frame is lost while A's paced receiver keeps acknowledging A's long lane. B's resend must not wait for A: the
 * loss is recovered on B's own deadline, before half of A's frames have gone ahead of it.
 */
const lossOnOneLaneIsNotHeldByAnother: MultiCase = async (adapters) => {
	const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
	const decode = (message: unknown) => adapters.transport.decode(message);
	const link = openLink(adapters, () => loseOnce(decode, "B", 1, stats));
	link.pace("A", LONG_LANE_PACE_MS);
	const aSends = range(1, LONG_LANE_FRAMES).map((n) => link.send("A", n));
	await link.runUntil(() => link.delivered("A").length >= 10, "MULTI-FAIR-02 A's long lane under way");
	const before = link.delivered("A").length;
	const bSend = link.send("B", 1);
	await link.runUntil(allDelivered(link, { B: 1 }), "MULTI-FAIR-02 B delivered after its loss", 600_000);
	if (stats.lost !== 1) throw new Error(`MULTI-FAIR-02: B#1 was not lost on the carrier (${JSON.stringify(stats)})`);
	const aheadOfB = link.delivered("A").length - before;
	if (aheadOfB >= LONG_LANE_FRAMES / 2) {
		throw new Error(
			`MULTI-FAIR-02: B's lost frame was resent only after ${aheadOfB} of A's frames (fewer than ${LONG_LANE_FRAMES / 2})`,
		);
	}
	await link.runUntil(allDelivered(link, { A: LONG_LANE_FRAMES }), "MULTI-FAIR-02 A delivered", 600_000);
	await link.awaitAll([...aSends, bSend], "MULTI-FAIR-02");
	await link.advance(2000);
	expectExactDelivery(link, { A: LONG_LANE_FRAMES, B: 1 }, "MULTI-FAIR-02");
};

export const MULTI_CASES: ReadonlyMap<string, MultiCase> = new Map([
	["MULTI-LANE-01", manyLanes],
	["MULTI-FAIR-01", fairness],
	["MULTI-FAIR-02", lossOnOneLaneIsNotHeldByAnother],
]);
