// senpi#4738 (R10.a): on the reference transport, lane order holds across a reconnect, and each lane resumes from its
// last acknowledged frame; an acknowledged frame is never sent again.
import { describe, expect, it } from "vitest";
import { createManualTimers } from "../../src/durable/testing/manual-timers.ts";
import { createInProcessNetwork } from "../../src/transport/in-process-carrier.ts";
import { localEndpoint } from "../../src/transport/local-endpoint.ts";
import { createReliableTransport, type ReferencePacket } from "../../src/transport/reliable-transport.ts";
import type { CarrierConnection, CarrierSide, TransportSide } from "../../src/transport/transport.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Sent {
	readonly attachment: number;
	readonly packet: ReferencePacket;
}

function tapped(side: TransportSide, sent: Sent[], link: { attachment: number; loseAcks: boolean }): CarrierSide {
	return {
		attached: (connection: CarrierConnection) =>
			side.attached({
				send: (message) => {
					const packet = message as ReferencePacket;
					sent.push({ attachment: link.attachment, packet });
					if (link.loseAcks && packet.kind === "ack") return true;
					return connection.send(message);
				},
				close: () => connection.close(),
			}),
		message: (message) => side.message(message),
		writable: () => side.writable(),
		detached: () => side.detached(),
	};
}

function setup() {
	const timers = createManualTimers(0);
	const network = createInProcessNetwork({ schedule: (deliver) => void timers.setTimer(deliver, 0) });
	const options = {
		clock: timers,
		window: 4,
		retransmitMs: 10_000,
		onHandlerError: (error: unknown) => {
			throw error;
		},
	};
	const sender = createReliableTransport(options);
	const receiver = createReliableTransport(options);
	const sent: Sent[] = [];
	const acks: Sent[] = [];
	const state = { attachment: 0, loseAcks: false };
	const endpoint = localEndpoint("linux", "lanes", "/run/senpi-test");
	network.listen(endpoint, tapped(receiver, acks, state));
	const link = network.dial(endpoint, tapped(sender, sent, state));
	const delivered: string[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	receiver.onFrame(async (frame) => {
		await gates.get(frame.lane)?.promise;
		delivered.push(`${frame.lane}:${decoder.decode(frame.payload)}`);
	});
	const step = async () => {
		await timers.advanceTo(timers.now() + 1);
		await yieldTurn();
	};
	const settle = async () => {
		for (let i = 0; i < 50; i++) await step();
	};
	return { sender, link, sent, state, delivered, gates, settle };
}

describe("lane order and resume across a reconnect (R10.a)", () => {
	it("resumes each lane from its last ACK, never re-sends an acknowledged frame, and delivers each frame once", async () => {
		const t = setup();
		t.gates.set("y", Promise.withResolvers<void>());
		t.link.connect();
		for (let n = 1; n <= 4; n++) {
			void t.sender.send("x", encoder.encode(`${n}`));
			void t.sender.send("y", encoder.encode(`${n}`));
		}
		await t.settle();
		expect(t.delivered).toEqual(["x:1", "x:2", "x:3", "x:4"]);
		expect([t.sender.inFlight("x"), t.sender.inFlight("y")]).toEqual([0, 4]);

		t.link.drop();
		const sends = [5, 6].map((n) => t.sender.send("x", encoder.encode(`${n}`)));
		await t.settle();
		expect(t.delivered).toHaveLength(4);
		t.state.attachment = 1;
		t.link.connect();
		await Promise.all(sends);
		await t.settle();

		const resumed = t.sent.filter((s) => s.attachment === 1 && s.packet.kind === "data").map((s) => s.packet);
		expect(resumed.filter((p) => p.lane === "x")[0]?.seq).toBe(5);
		expect(resumed.filter((p) => p.lane === "y")[0]?.seq).toBe(1);
		expect(resumed.some((p) => p.lane === "x" && p.seq <= 4)).toBe(false);

		t.gates.get("y")?.resolve();
		await t.settle();
		expect(t.delivered).toEqual(["x:1", "x:2", "x:3", "x:4", "x:5", "x:6", "y:1", "y:2", "y:3", "y:4"]);
		expect([t.sender.inFlight("x"), t.sender.inFlight("y")]).toEqual([0, 0]);
	});

	it("re-sends delivered frames whose ACKs were lost, and the receiver does not deliver them again", async () => {
		const t = setup();
		t.state.loseAcks = true;
		t.link.connect();
		await Promise.all([1, 2, 3].map((n) => t.sender.send("x", encoder.encode(`${n}`))));
		await t.settle();
		expect(t.delivered).toEqual(["x:1", "x:2", "x:3"]);
		expect(t.sender.inFlight("x")).toBe(3);

		t.link.drop();
		t.state.loseAcks = false;
		t.state.attachment = 1;
		t.link.connect();
		await t.settle();
		const resumed = t.sent.filter((s) => s.attachment === 1 && s.packet.kind === "data").map((s) => s.packet.seq);
		expect(resumed[0]).toBe(1);
		expect(t.delivered).toEqual(["x:1", "x:2", "x:3"]);
		expect(t.sender.inFlight("x")).toBe(0);
	});
});
