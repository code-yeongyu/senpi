import type { CaseImplementation } from "../../conformance/runner.ts";
import { createCarrierFault, FAULT_PROFILE_NAMES, type FaultProfileName, type FaultStats } from "./fault-transport.ts";
import { allDelivered, expectExactDelivery, openLink, range, type TransportCaseAdapters } from "./transport-harness.ts";

type FaultCase = CaseImplementation<TransportCaseAdapters>;

const LANES = ["a", "b", "c"];
const FRAMES = 30;
const PACE_MS = 20;

const applied: Record<FaultProfileName, (stats: FaultStats) => boolean> = {
	slow: (stats) => stats.refused > 0,
	lossy: (stats) => stats.lost > 0,
	laggy: (stats) => stats.reordered > 0,
	flap: (stats) => stats.drops >= 2,
	"drop-reattach": (stats) => stats.drops >= 2,
};

const underProfile =
	(name: FaultProfileName): FaultCase =>
	async (adapters) => {
		const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
		const link = openLink(adapters, createCarrierFault(name, stats));
		const counts = Object.fromEntries(LANES.map((lane) => [lane, FRAMES]));
		const sends: Promise<void>[] = [];
		for (const n of range(1, FRAMES)) {
			sends.push(...LANES.map((lane) => link.send(lane, n)));
			await link.advance(PACE_MS);
		}
		await link.runUntil(allDelivered(link, counts), `FAULT-TRANSPORT ${name}: every frame delivered`, 600_000);
		await link.awaitAll(sends, `FAULT-TRANSPORT ${name}`);
		await link.advance(2000);
		expectExactDelivery(link, counts, `FAULT-TRANSPORT ${name}`);
		if (!applied[name](stats))
			throw new Error(`FAULT-TRANSPORT ${name}: the profile never acted (${JSON.stringify(stats)})`);
	};

export const FAULT_TRANSPORT_CASES: ReadonlyMap<string, FaultCase> = new Map(
	FAULT_PROFILE_NAMES.map((name, index) => [`FAULT-TRANSPORT-0${index + 1}`, underProfile(name)]),
);
