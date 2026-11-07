import { createCipheriv, hkdfSync } from "node:crypto";
import { once } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { InternalRecordCipher } from "../../src/modes/rpc/internal-record-cipher.ts";
import { createInternalRecordStream } from "../../src/modes/rpc/internal-record-stream.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

const key = Buffer.alloc(32, 7);
const clientNonce = Buffer.alloc(32, 11);
const serverNonce = Buffer.alloc(32, 13);
const salt = Buffer.concat([clientNonce, serverNonce]);
const derived = Buffer.from(hkdfSync("sha256", key, salt, "senpi-rpc-internal c2s", 32));

// One end of an in-memory wire: reads from `readable`, writes to `writable`, and keeps both sides' backpressure.
function joined(readable: PassThrough, writable: PassThrough): Duplex {
	const duplex = new Duplex({
		read() {
			readable.resume();
		},
		write(chunk: Buffer, _encoding, callback) {
			if (writable.write(chunk)) callback();
			else writable.once("drain", () => callback());
		},
		final(callback) {
			writable.end(callback);
		},
	});
	readable.on("data", (chunk: Buffer) => {
		if (!duplex.push(chunk)) readable.pause();
	});
	readable.once("end", () => duplex.push(null));
	return duplex;
}

// senpi#3795: the hop is an authenticated byte stream, not one record per JSONL line.
describe("internal sealed records", () => {
	it("matches the independent AES-GCM wire contract", () => {
		const plaintext = Buffer.from("hello");
		const expectedCipher = createCipheriv("aes-256-gcm", derived, Buffer.alloc(12));
		expectedCipher.setAAD(Buffer.concat([Buffer.from("c2s"), Buffer.alloc(8)]));
		const body = Buffer.concat([
			expectedCipher.update(plaintext),
			expectedCipher.final(),
			expectedCipher.getAuthTag(),
		]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(body.length);
		expect(new InternalRecordCipher(derived, "c2s").seal(plaintext)).toEqual(Buffer.concat([length, body]));
		expect(new InternalRecordCipher(derived, "c2s").open(body)).toEqual(plaintext);
	});

	it.each(["tamper", "reorder", "replay", "direction"] as const)(
		"rejects %s without releasing plaintext",
		(attack) => {
			const sender = new InternalRecordCipher(derived, "c2s");
			const first = sender.seal(Buffer.from("first")).subarray(4);
			const second = sender.seal(Buffer.from("second")).subarray(4);
			const receiver = new InternalRecordCipher(derived, attack === "direction" ? "s2c" : "c2s");
			let forged = Buffer.from(first);
			if (attack === "tamper") forged[0] ^= 1;
			if (attack === "reorder") forged = Buffer.from(second);
			if (attack === "replay") expect(receiver.open(first).toString()).toBe("first");
			expect(() => receiver.open(forged)).toThrow();
		},
	);

	it.each([0, 16, 65553])("rejects invalid body length %s", (length) => {
		expect(() => new InternalRecordCipher(derived, "c2s").open(Buffer.alloc(length))).toThrow();
	});

	it("closes a direction at the 2^32 record bound", () => {
		const sender = new InternalRecordCipher(derived, "c2s", 0xffff_ffffn);
		const receiver = new InternalRecordCipher(derived, "c2s", 0xffff_ffffn);
		expect(receiver.open(sender.seal(Buffer.from("last")).subarray(4)).toString()).toBe("last");
		expect(() => sender.seal(Buffer.from("overflow"))).toThrow();
		expect(() => receiver.open(Buffer.alloc(17))).toThrow();
	});

	it("preserves a 131 KiB JSONL line across records and backpressure", async () => {
		const a = new PassThrough({ highWaterMark: 32 });
		const b = new PassThrough({ highWaterMark: 32 });
		const client = createInternalRecordStream(joined(b, a), key, clientNonce, serverNonce, "client");
		const host = createInternalRecordStream(joined(a, b), key, clientNonce, serverNonce, "server");
		const line = JSON.stringify({ text: "x".repeat(131 * 1024) });
		const received = new Promise<string>((resolve) => attachJsonlLineReader(host, resolve));
		try {
			expect(client.write(`${line}\n`)).toBe(false);
			expect(await received).toBe(line);
			const reply = once(client, "data");
			host.write("reply\n");
			expect(String((await reply)[0])).toBe("reply\n");
		} finally {
			client.destroy();
			host.destroy();
		}
	});

	it("handles fragmented headers and coalesced records", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const stream = createInternalRecordStream(joined(input, output), key, clientNonce, serverNonce, "server");
		const sender = new InternalRecordCipher(derived, "c2s");
		const wire = Buffer.concat([sender.seal(Buffer.from("one")), sender.seal(Buffer.from("two"))]);
		const received: Buffer[] = [];
		stream.on("data", (chunk: Buffer) => received.push(chunk));
		const ended = once(stream, "end");
		input.write(wire.subarray(0, 1));
		input.write(wire.subarray(1, 5));
		input.end(wire.subarray(5));
		await ended;
		expect(Buffer.concat(received).toString()).toBe("onetwo");
		stream.destroy();
	});

	it.each(["header", "body", "length"] as const)("closes on incomplete or invalid %s at EOF", async (part) => {
		const input = new PassThrough();
		const output = new PassThrough();
		const stream = createInternalRecordStream(joined(input, output), key, clientNonce, serverNonce, "server");
		const errors = once(stream, "error");
		const record = new InternalRecordCipher(derived, "c2s").seal(Buffer.from("never released"));
		let released = 0;
		stream.on("data", () => released++);
		input.end(part === "header" ? record.subarray(0, 2) : part === "body" ? record.subarray(0, -1) : Buffer.alloc(4));
		await errors;
		expect(released).toBe(0);
		expect(stream.destroyed).toBe(true);
	});
});
