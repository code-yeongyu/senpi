import { uptime } from "node:os";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";

const AN_HOUR_MS = 60 * 60_000;

/**
 * The same move records read an hour later, by the wall clock and by the machine's uptime. A stamped record whose
 * file never landed is settled failed at once on a tree that does not age its stamp, and only once the stamp is old
 * on one that does (senpi#6463): read an hour later, both answer the same.
 */
export function anHourLater(ledger: MoveLedger): MoveLedger {
	const clocks = { now: () => Date.now() + AN_HOUR_MS, uptime: () => uptime() * 1000 + AN_HOUR_MS };
	return new MoveLedger(ledger.dir, clocks);
}
