import { hkdfSync } from "node:crypto";
import { Duplex } from "node:stream";
import { INTERNAL_RECORD_MAX, type InternalDirection, InternalRecordCipher } from "./internal-record-cipher.ts";

/** A bounded byte stream: record boundaries are invisible to the existing JSONL reader. */
export function createInternalRecordStream(
	wire: Duplex,
	key: Buffer,
	clientNonce: Buffer,
	serverNonce: Buffer,
	role: "client" | "server",
): Duplex {
	const salt = Buffer.concat([clientNonce, serverNonce]);
	const cipher = (direction: InternalDirection) =>
		new InternalRecordCipher(
			Buffer.from(hkdfSync("sha256", key, salt, `senpi-rpc-internal ${direction}`, 32)),
			direction,
		);
	return new InternalRecordStream(
		wire,
		cipher(role === "client" ? "c2s" : "s2c"),
		cipher(role === "client" ? "s2c" : "c2s"),
	);
}

class InternalRecordStream extends Duplex {
	private readonly wire: Duplex;
	private readonly sender: InternalRecordCipher;
	private readonly receiver: InternalRecordCipher;
	private readonly header = Buffer.alloc(4);
	private headerUsed = 0;
	private body: Buffer | undefined;
	private bodyUsed = 0;
	private pending: Buffer | undefined;
	private offset = 0;
	/** The peer finished sending (end or close); records still pending are delivered before the readable side ends. */
	private wireDone = false;
	private wireClosed = false;
	private ended = false;

	constructor(wire: Duplex, sender: InternalRecordCipher, receiver: InternalRecordCipher) {
		super();
		this.wire = wire;
		this.sender = sender;
		this.receiver = receiver;
		// A transport failure is always delivered as close, including before an owner attaches. A record that fails
		// framing or verification is logged once per stream by its code (never key or plaintext material).
		this.once("error", (error) => {
			if (error.message.startsWith("internal_record"))
				process.stderr.write(`senpi rpc: internal hop closed: ${error.message}\n`);
		});
		this.on("error", () => {});
		wire.on("data", (chunk: Buffer) => {
			wire.pause();
			this.pending = chunk;
			this.offset = 0;
			this.consume();
		});
		// A peer that ends while records wait behind backpressure has still sent them complete and verifiable:
		// they are delivered first, and only an incomplete trailing record is truncation (senpi#3816 review).
		wire.once("end", () => {
			this.wireDone = true;
			if (this.pending === undefined) this.finish();
		});
		wire.once("error", (error) => this.destroy(error));
		wire.once("close", () => {
			this.wireDone = true;
			this.wireClosed = true;
			if (this.ended && this.readableEnded) this.destroy();
			else if (this.pending === undefined) this.finish();
		});
		// Once the reader has every delivered record and the transport is gone, the stream closes as before.
		this.once("end", () => {
			if (this.wireClosed) this.destroy();
		});
	}

	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		if (this.headerUsed !== 0 || this.body !== undefined) this.destroy(new Error("internal_record_truncated"));
		else this.push(null);
	}

	private consume(): void {
		try {
			const chunk = this.pending;
			if (!chunk) return;
			while (this.offset < chunk.length) {
				if (!this.body) {
					const n = Math.min(4 - this.headerUsed, chunk.length - this.offset);
					chunk.copy(this.header, this.headerUsed, this.offset, this.offset + n);
					this.headerUsed += n;
					this.offset += n;
					if (this.headerUsed !== 4) break;
					const length = this.header.readUInt32BE();
					if (length < 17 || length > INTERNAL_RECORD_MAX + 16) throw new Error("internal_record_length");
					this.headerUsed = 0;
					this.body = Buffer.alloc(length);
				}
				const n = Math.min(this.body.length - this.bodyUsed, chunk.length - this.offset);
				chunk.copy(this.body, this.bodyUsed, this.offset, this.offset + n);
				this.bodyUsed += n;
				this.offset += n;
				if (this.bodyUsed === this.body.length) {
					const plaintext = this.receiver.open(this.body);
					this.body = undefined;
					this.bodyUsed = 0;
					if (!this.push(plaintext)) {
						if (this.offset === chunk.length) {
							this.pending = undefined;
							if (this.wireDone) this.finish();
						}
						return;
					}
				}
			}
			this.pending = undefined;
			if (this.wireDone) this.finish();
			else this.wire.resume();
		} catch (cause) {
			// A record that fails authentication surfaces as the cipher's own error; name it by the record contract.
			this.destroy(
				cause instanceof Error && cause.message.startsWith("internal_record")
					? cause
					: new Error("internal_record_unverified", { cause }),
			);
		}
	}

	override _read(): void {
		if (this.pending) this.consume();
		else this.wire.resume();
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		let offset = 0;
		const next = (error?: Error | null): void => {
			if (error) {
				callback(error);
				return;
			}
			if (this.destroyed) {
				callback(new Error("internal_hop_lost"));
				return;
			}
			if (offset === chunk.length) {
				callback();
				return;
			}
			try {
				const end = Math.min(chunk.length, offset + INTERNAL_RECORD_MAX);
				const record = this.sender.seal(chunk.subarray(offset, end));
				offset = end;
				// Await each downstream write, not just each whole JSONL line.
				this.wire.write(record, next);
			} catch (cause) {
				callback(cause instanceof Error ? cause : new Error("internal_record_invalid"));
			}
		};
		next();
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.wire.end(callback);
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.wire.destroy();
		callback(error);
	}
}
