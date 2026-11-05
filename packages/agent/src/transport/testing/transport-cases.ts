import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { allDelivered, expectExactDelivery, openLink, range, type TransportCaseAdapters } from "./transport-harness.ts";

type TransportCase = CaseImplementation<TransportCaseAdapters>;

const order: TransportCase = async (adapters) => {
	const link = openLink(adapters);
	const counts = { a: 40, b: 40, c: 40 };
	const sends = range(1, 40).flatMap((n) => ["a", "b", "c"].map((lane) => link.send(lane, n)));
	await link.runUntil(allDelivered(link, counts), "TRANSPORT-01 every frame delivered");
	await link.awaitAll(sends, "TRANSPORT-01");
	await link.advance(1000);
	expectExactDelivery(link, counts, "TRANSPORT-01");
};

const resume: TransportCase = async (adapters) => {
	const link = openLink(adapters);
	const counts = { a: 30, b: 30 };
	const sends = range(1, 10).flatMap((n) => [link.send("a", n), link.send("b", n)]);
	await link.runUntil(() => link.delivered("a").length >= 4, "TRANSPORT-02 first frames delivered");
	link.link.drop();
	sends.push(...range(11, 20).flatMap((n) => [link.send("a", n), link.send("b", n)]));
	await link.advance(500);
	if (link.sender.inFlight("a") + link.sender.inFlight("b") === 0) {
		throw new Error("TRANSPORT-02: expected unacknowledged frames while the carrier is down");
	}
	link.link.connect();
	await link.runUntil(() => link.delivered("a").length >= 15, "TRANSPORT-02 resumed after the first re-attach");
	link.link.drop();
	sends.push(...range(21, 30).flatMap((n) => [link.send("a", n), link.send("b", n)]));
	link.link.connect();
	await link.runUntil(allDelivered(link, counts), "TRANSPORT-02 every frame delivered after two re-attaches");
	await link.awaitAll(sends, "TRANSPORT-02");
	await link.advance(1000);
	expectExactDelivery(link, counts, "TRANSPORT-02");
};

const backpressure: TransportCase = async (adapters) => {
	const link = openLink(adapters);
	const release = link.gate("slow");
	const resolved: number[] = [];
	const sends = range(1, 200).map((n) => link.send("slow", n).then(() => void resolved.push(n)));
	await link.advance(2000);
	const admitted = resolved.length;
	if (admitted === 0 || admitted >= 200) {
		throw new Error(`TRANSPORT-03: a stalled receiver must bound the senders, but ${admitted} of 200 sends resolved`);
	}
	await link.advance(2000);
	expectEqual(resolved.length, admitted, "TRANSPORT-03 the bound holds while the receiver stays stalled");
	expectEqual(link.delivered("slow"), [], "TRANSPORT-03 nothing delivered while the receiver is stalled");
	if (link.sender.inFlight("slow") > admitted) throw new Error("TRANSPORT-03: more in flight than admitted");
	release();
	await link.runUntil(allDelivered(link, { slow: 200 }), "TRANSPORT-03 every frame delivered after release");
	await link.awaitAll(sends, "TRANSPORT-03");
	expectEqual(resolved, range(1, 200), "TRANSPORT-03 sends resolve in send order");
	await link.advance(1000);
	expectExactDelivery(link, { slow: 200 }, "TRANSPORT-03");
};

export const TRANSPORT_CASES: ReadonlyMap<string, TransportCase> = new Map([
	["TRANSPORT-01", order],
	["TRANSPORT-02", resume],
	["TRANSPORT-03", backpressure],
]);
