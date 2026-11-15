// senpi#6767 (omo-service#1176 gaps 2 and 4): the brain end of the wake link reports a frame it cannot decode, and a
// best-effort drop report reaches the session as the warning notice a durable one gives.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { deliverHandDrop } from "../../src/execution/wake-delivery.ts";
import { createWakeInbox } from "../../src/execution/wake-inbox.ts";
import { encodeWakeLinkMessage, HAND_WAKE_LANE, serveHandWakes, type WakeDrop } from "../../src/execution/wake-link.ts";
import { createInProcessNetwork } from "../../src/transport/in-process-carrier.ts";
import { localEndpoint } from "../../src/transport/local-endpoint.ts";
import { createReliableTransport } from "../../src/transport/reliable-transport.ts";
import type { TransportSide } from "../../src/transport/transport.ts";

function side(): TransportSide {
	return createReliableTransport({
		clock: {
			now: () => Date.now(),
			setTimer: (callback, ms) => {
				const timer = setTimeout(callback, ms);
				return () => clearTimeout(timer);
			},
		},
		onHandlerError: (error) => {
			throw error;
		},
	});
}

async function brainLink() {
	const network = createInProcessNetwork();
	const endpoint = localEndpoint("linux", `wake-link-${crypto.randomUUID()}`, "/tmp");
	const [brain, hand] = [side(), side()];
	network.listen(endpoint, hand);
	network.dial(endpoint, brain).connect();
	const medium = createMemoryStoreMedium();
	await openMemoryStore(medium).claim(0, 1);
	const faults = Promise.withResolvers<unknown>();
	const dropped = Promise.withResolvers<WakeDrop>();
	serveHandWakes({
		transport: brain,
		inbox: createWakeInbox({
			issuer: "brain",
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => 0,
			owner: () => "hand",
		}),
		hand: "hand",
		onCommitted: () => {},
		onDropped: dropped.resolve,
		onFault: faults.resolve,
	});
	return { hand, faults: faults.promise, dropped: dropped.promise };
}

describe("the brain end of the wake link", () => {
	it("reports a frame it cannot decode to onFault instead of ignoring it", async () => {
		const link = await brainLink();

		await link.hand.send(HAND_WAKE_LANE, new TextEncoder().encode('{"kind":"wake","wake":{"scope":7}}'));

		expect(String(await link.faults)).toMatch(/undecodable frame on hand\.wake/);
	});

	it("hands a best-effort drop report to onDropped, which becomes the session's warning notice", async () => {
		const link = await brainLink();
		const notices: unknown[] = [];

		await link.hand.send(
			HAND_WAKE_LANE,
			encodeWakeLinkMessage({ kind: "wake_dropped", scope: "s", reason: "unrecorded", count: 2 }),
		);
		deliverHandDrop(await link.dropped, { notify: (...args) => void notices.push(args) });

		expect(notices).toEqual([
			["2 late results from work on the user's machine never arrived (unrecorded).", "warning"],
		]);
	});
});
