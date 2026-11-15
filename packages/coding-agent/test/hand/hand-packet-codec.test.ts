// The hand wire codec (senpi#5840, R3 `hand_link`): the one encoding the socket carrier and `hand_link` batches share,
// a frame over the part size as `data_part` packets joined by count and index, and every malformed shape refused.
import { describe, expect, it } from "vitest";
import {
	createHandPacketReader,
	encodeHandPackets,
	HAND_PACKET_MAX_PARTS,
	HAND_PACKET_MAX_PENDING_JOINS,
	HAND_PACKET_PART_BYTES,
	type HandWirePacket,
} from "../../src/modes/hand/hand-packet-codec.ts";

const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);
const wire = (packets: readonly HandWirePacket[] | undefined): unknown[] => JSON.parse(JSON.stringify(packets ?? []));

describe("hand packet codec", () => {
	it("round-trips a data packet and an ack through JSON", () => {
		const read = createHandPacketReader();
		const data = { kind: "data", lane: "scope-1", seq: 3, payload: bytes(64) };
		const ack = { kind: "ack", lane: "hand.control", seq: 7 };

		expect(wire(encodeHandPackets(data)).map(read)).toEqual([data]);
		expect(wire(encodeHandPackets(ack)).map(read)).toEqual([ack]);
	});

	it("splits a frame over the part size into data_part packets and joins them back, a resent part included", () => {
		const payload = bytes(HAND_PACKET_PART_BYTES * 2 + 5);
		const parts = wire(encodeHandPackets({ kind: "data", lane: "scope-1", seq: 4, payload }));
		const read = createHandPacketReader();

		expect(parts).toHaveLength(3);
		expect(parts.map((part) => Reflect.get(Object(part), "kind"))).toEqual(["data_part", "data_part", "data_part"]);
		expect([read(parts[0]), read(parts[0]), read(parts[1])]).toEqual([null, null, null]);
		expect(read(parts[2])).toEqual({ kind: "data", lane: "scope-1", seq: 4, payload });
	});

	it("refuses a count conflict, an index out of range, an unknown kind and a payload that is not a string", () => {
		const part = { kind: "data_part", lane: "s", seq: 1, payload: "" };
		const read = createHandPacketReader();

		expect(read({ ...part, index: 0, count: 2 })).toBeNull();
		expect(read({ ...part, index: 1, count: 3 })).toBeUndefined();
		for (const malformed of [
			{ ...part, index: 2, count: 2 },
			{ ...part, index: 0, count: 1 },
			{ kind: "data", lane: "s", seq: 1, payload: 7 },
			{ kind: "nack", lane: "s", seq: 1 },
			{ kind: "ack", lane: "s", seq: -1 },
			"ack",
		])
			expect(createHandPacketReader()(malformed)).toBeUndefined();
	});

	it("bounds joins: no more parts than one record line can carry, and a capped number of unfinished frames", () => {
		const part = (seq: number, count: number) => ({
			kind: "data_part",
			lane: "s",
			seq,
			index: 0,
			count,
			payload: "",
		});
		const read = createHandPacketReader();

		expect(read(part(1, HAND_PACKET_MAX_PARTS + 1))).toBeUndefined();
		for (let seq = 1; seq <= HAND_PACKET_MAX_PENDING_JOINS; seq++) expect(read(part(seq, 2))).toBeNull();
		expect(read(part(HAND_PACKET_MAX_PENDING_JOINS + 1, 2))).toBeUndefined();
		expect(read({ ...part(1, 2), index: 1 })).toMatchObject({ kind: "data", seq: 1 });
		expect(read(part(HAND_PACKET_MAX_PENDING_JOINS + 1, HAND_PACKET_MAX_PARTS))).toBeNull();
	});

	it("never carries what is not a reference packet", () => {
		expect(encodeHandPackets({ kind: "data", lane: "s", seq: 1, payload: "text" })).toBeUndefined();
		expect(encodeHandPackets({ kind: "hello" })).toBeUndefined();
	});
});
