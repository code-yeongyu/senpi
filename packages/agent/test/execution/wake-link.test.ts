// senpi#6767 (omo-service#1176 gaps 2 and 4): the brain end of the wake link reports a frame it cannot decode, and a
// best-effort drop report reaches the session as the warning notice a durable one gives.
import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import { deliverHandDrop, scopeSessionCheck } from "../../src/execution/wake-delivery.ts";
import { createWakeOutbox } from "../../src/execution/wake-outbox.ts";
import { createWakeInbox } from "../../src/execution/wake-inbox.ts";
import {
	createHandWakeLink,
	encodeWakeLinkMessage,
	HAND_WAKE_LANE,
	serveHandWakes,
	type WakeDrop,
} from "../../src/execution/wake-link.ts";
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

describe("a session-naming wake across a brain restart (review round 2, M4)", () => {
	it("is re-offered while its scope is not bound yet, and committed once the scope binds", async () => {
		let sessions: ReadonlySet<string> | undefined;
		const network = createInProcessNetwork();
		const endpoint = localEndpoint("linux", `wake-m4-${crypto.randomUUID()}`, "/tmp");
		const [brain, hand] = [side(), side()];
		network.listen(endpoint, hand);
		network.dial(endpoint, brain).connect();
		const [brainMedium, handMedium] = [createMemoryStoreMedium(), createMemoryStoreMedium()];
		await openMemoryStore(brainMedium).claim(0, 1);
		await openMemoryStore(handMedium).claim(0, 1);
		const committed = Promise.withResolvers<string>();
		const refused = Promise.withResolvers<void>();
		const acked = Promise.withResolvers<void>();
		const link = serveHandWakes({
			transport: brain,
			inbox: createWakeInbox({
				issuer: "brain",
				store: openMemoryStore(brainMedium),
				epoch: 1,
				admission: createAdmissionLine(),
				clock: () => 0,
				owner: () => (sessions === undefined ? undefined : "hand"),
			}),
			hand: "hand",
			check: scopeSessionCheck(() => sessions),
			onCommitted: (wake) => committed.resolve(wake.eventId),
			onDropped: () => {},
			onFault: () => {},
		});
		const outbox = createWakeOutbox({
			hand: "h",
			store: openMemoryStore(handMedium),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => 0,
		});
		const watched = {
			...outbox,
			receipt: async (receipt: Parameters<typeof outbox.receipt>[0]) => {
				await outbox.receipt(receipt);
				if (receipt.kind === "refused") refused.resolve();
				else acked.resolve();
			},
		};
		const handLink = createHandWakeLink({ transport: hand, outbox: watched, onFault: () => {} });
		await handLink.ready;

		await handLink.offer({ scope: "s", source: "notice", payload: { message: "late", sessionId: "loop-1" } });
		await refused.promise;
		sessions = new Set(["loop-1"]);
		link.reoffer();

		expect(await committed.promise).toMatch(/^h:/);
		await acked.promise;
		expect(await outbox.pending()).toEqual([]);
	});
});

describe("the hand end of the wake link (review round 2, L5)", () => {
	it("reports a frame it cannot decode to onFault", async () => {
		const network = createInProcessNetwork();
		const endpoint = localEndpoint("linux", `wake-hand-${crypto.randomUUID()}`, "/tmp");
		const [brain, hand] = [side(), side()];
		network.listen(endpoint, hand);
		network.dial(endpoint, brain).connect();
		const medium = createMemoryStoreMedium();
		await openMemoryStore(medium).claim(0, 1);
		const outbox = createWakeOutbox({
			hand: "h",
			store: openMemoryStore(medium),
			epoch: 1,
			admission: createAdmissionLine(),
			clock: () => 0,
		});
		const fault = Promise.withResolvers<unknown>();
		createHandWakeLink({ transport: hand, outbox, onFault: fault.resolve });

		await brain.send(HAND_WAKE_LANE, new TextEncoder().encode('{"kind":"wake_receipt","receipt":{"kind":"ack"}}'));

		expect(String(await fault.promise)).toMatch(/undecodable frame on hand\.wake/);
	});
});

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
